/** Run with mise exec -- node scripts/check-document-ui-browser.mjs after building apps/web. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "document-ui-chrome-"));
const log = fs.openSync(path.join(profile, "chrome.log"), "w");
const chrome = spawn(process.env.CHROME_BIN ?? "/usr/bin/google-chrome", [
  "--headless", "--password-store=basic", "--use-mock-keychain", "--no-sandbox", "--no-proxy-server", "--disable-dev-shm-usage", "--disable-gpu", "--disable-background-networking",
  // Prevent cached test pages from retaining EventSource connections across repeated full reloads.
  "--disable-features=Vulkan,BackForwardCache", "--disable-component-update", "--disable-sync", "--disable-extensions", "--no-first-run", "--no-default-browser-check",
  "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank",
], { stdio: ["ignore", log, log] });
const fixture = spawn(process.execPath, ["--import", "tsx", "test/fixtures/documents-ui-server.ts"], {
  cwd: path.join(repository, "apps/server"), stdio: ["ignore", "pipe", "pipe"],
});
let socket;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  const setup = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Fixture startup timeout")), 15000);
    fixture.on("exit", () => { clearTimeout(timer); reject(new Error("Fixture exited before ready")); });
    fixture.stdout.on("data", chunk => {
      output += chunk;
      if (output.includes("\n")) { clearTimeout(timer); resolve(JSON.parse(output.split("\n")[0])); }
    });
    fixture.stderr.on("data", chunk => process.stderr.write(chunk));
  });
  const origin = `http://127.0.0.1:${setup.port}`;
  console.log(`Fixture ready: ${origin}`);
  const portFile = path.join(profile, "DevToolsActivePort");
  for (let i = 0; !fs.existsSync(portFile) && i < 100; i++) await pause(100);
  const debugPort = Number(fs.readFileSync(portFile, "utf8").split("\n")[0]);
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  socket = new WebSocket(targets.find(page => page.type === "page").webSocketDebuggerUrl);
  await once(socket, "open");
  let sequence = 0;
  const browserLogs = [];
  const networkUrls = [];
  const inflight = new Map();
  const pending = new Map();
  socket.addEventListener("message", event => {
    const result = JSON.parse(event.data);
    if (result.method === "Network.requestWillBeSent") { networkUrls.push(result.params.request.url); inflight.set(result.params.requestId, result.params.request.url); }
    if (["Network.loadingFinished", "Network.loadingFailed"].includes(result.method)) inflight.delete(result.params.requestId);
    if (result.method === "Runtime.consoleAPICalled") browserLogs.push(JSON.stringify(result.params.args));
    if (result.method === "Page.javascriptDialogOpening" && result.params.type === "beforeunload") { void send("Page.handleJavaScriptDialog", { accept: true }); return; }
    if (!result.id) return;
    const request = pending.get(result.id); if (!request) return;
    pending.delete(result.id); clearTimeout(request.timer);
    if (result.error) request.reject(new Error(result.error.message)); else request.resolve(result.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    if (method === "Page.navigate") console.log("Navigate", params.url);
    const id = ++sequence, timer = setTimeout(() => { console.log("Pending fixture paths:", [...inflight.values()].map(url => new URL(url).pathname)); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const response = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(`Browser expression failed: ${response.exceptionDetails.text}`);
    return response.result.value;
  };
  const wait = async expression => {
    for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await pause(50); }
    const diagnostic = await evaluate(`JSON.stringify({active:document.activeElement?.id,editorState:document.querySelector('.document-editor [role=status]')?.textContent,dialogs:Array.from(document.querySelectorAll('[role=dialog]')).map(d=>({state:d.getAttribute('data-state'),heading:d.querySelector('h2')?.textContent,buttons:Array.from(d.querySelectorAll('button')).map(b=>({label:b.textContent,disabled:b.disabled}))}))})`);
    console.log("Fixture UI diagnostic:", diagnostic, "pending requests:", [...inflight.values()].map(url => new URL(url).pathname));
    await screenshot("failure");
    throw new Error(`Browser condition not reached: ${expression}`);
  };
  const key = async (key, code, virtual, modifiers = 0) => {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: virtual, modifiers });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: virtual, modifiers });
  };
  const click = async (text, scope = "document") => {
    const point = await evaluate(`(() => { const button = Array.from(${scope}.querySelectorAll('button')).find(b => (b.textContent.trim() === ${JSON.stringify(text)} || b.firstElementChild?.textContent.trim() === ${JSON.stringify(text)}) && b.getClientRects().length && !b.disabled); if (!button) return null; button.scrollIntoView({block:'nearest'}); const r = button.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    assert.ok(point, `Missing enabled button: ${text}`);
    await send("Input.dispatchMouseEvent", {type:"mousePressed", ...point, button:"left", clickCount:1});
    await send("Input.dispatchMouseEvent", {type:"mouseReleased", ...point, button:"left", clickCount:1});
    await pause(250);
  };
  const dialog = "document.querySelector('[role=dialog][data-state=open]')";
  // Secondary editor actions live in the "More actions" menu; Radix items are menuitems, not buttons.
  const menu = async text => {
    const trigger = await evaluate(`(() => { const b = document.querySelector('.document-editor button[aria-label="More actions"]'); if (!b) return null; const r = b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    assert.ok(trigger, "Missing More actions");
    await send("Input.dispatchMouseEvent", {type:"mousePressed", ...trigger, button:"left", clickCount:1});
    await send("Input.dispatchMouseEvent", {type:"mouseReleased", ...trigger, button:"left", clickCount:1});
    await wait(`Array.from(document.querySelectorAll('[role=menuitem]')).some(i => i.textContent.startsWith(${JSON.stringify(text)}))`);
    await evaluate(`Array.from(document.querySelectorAll('[role=menuitem]')).find(i => i.textContent.startsWith(${JSON.stringify(text)})).click()`);
    await pause(150);
  };
  const bodyValue = () => evaluate("document.querySelector('#document-body').value");
  const replaceBody = async value => {
    await evaluate("document.querySelector('#document-body').focus()");
    await key("a", "KeyA", 65, 2); await send("Input.insertText", { text: value }); await pause(50);
  };
  const results = [];
  const record = message => { results.push(message); console.log(`PASS: ${message}`); };
  const screenshot = async name => {
    if (!process.env.DOCUMENT_UI_SCREENSHOT_DIR) return;
    fs.mkdirSync(process.env.DOCUMENT_UI_SCREENSHOT_DIR, {recursive:true});
    const shot = await send("Page.captureScreenshot", {format:"png"});
    fs.writeFileSync(path.join(process.env.DOCUMENT_UI_SCREENSHOT_DIR, `${name}.png`), Buffer.from(shot.data, "base64"));
  };
  await send("Page.navigate", { url: "data:text/html,Fixture%20browser%20ready" });
  await send("Runtime.enable");
  await send("Network.enable");
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1360, height: 950, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: origin });
  await wait("!!document.querySelector('body')");
  await evaluate("localStorage.setItem('agent-hub-language', 'en')");
  await evaluate(`fetch('/api/auth', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({token:'fictional-document-ui-fixture'})}).then(r=>r.ok)`);
  await send("Page.navigate", { url: `${origin}/?view=documents&document=${setup.first}` });
  await wait("!!document.querySelector('#document-body')");
  assert.equal(await evaluate("document.querySelector('#document-body').readOnly"), false);
  // A direct desktop document link must survive real Back/Forward before any internal navigation.
  await evaluate("history.back()"); await wait("!location.search.includes('view=documents')");
  await evaluate("history.forward()"); await wait("location.search.includes('view=documents')");
  await wait("!!document.querySelector('#document-body') && !document.querySelector('.document-workspace').hidden");
  const historyLength = await evaluate("history.length");
  await click("Document list", "document.querySelector('.document-workspace header')");
  await click("Back to task list", "document.querySelector('.document-workspace header')");
  await click("Documents");
  assert.equal(await evaluate("history.length"), historyLength);
  await wait("!document.querySelector('.document-workspace').hidden");
  record("Desktop direct-link Back/Forward and replace-only Documents transitions");
  // Start without an editor. The real Create commits, but its success response is unreadable.
  await send("Page.navigate", {url:`${origin}/?view=documents`});
  await wait("!!document.querySelector('.document-workspace') && !document.querySelector('.document-workspace').hidden");
  await click("Create document", "document.querySelector('.document-workspace header')");
  await evaluate("document.querySelector('[role=dialog][data-state=open] input').focus()");
  await send("Input.insertText", {text:"Fictional unknown create"});
  await evaluate("fetch('/__test/lose-create-response',{method:'POST'})");
  await click("Create document", dialog);
  await wait("!!document.querySelector('[role=dialog][data-state=open] input[type=checkbox]')");
  assert.equal(await evaluate("!!document.querySelector('#document-body')"), false);
  assert.equal((await evaluate("fetch('/__test/state').then(r=>r.json())")).createPosts, 1);
  await key("Escape", "Escape", 27); await pause(250);
  assert.ok(await evaluate("!!document.querySelector('[data-document-create-unknown]')"));
  // A confirmed 401 must not erase the earlier unknown create or make it unreachable without an editor.
  await click("Create document", "document.querySelector('.document-workspace header')");
  await send("Network.clearBrowserCookies");
  await evaluate("document.querySelector('[role=dialog][data-state=open] input[type=checkbox]').click()");
  await click("Create document", dialog);
  await wait("document.querySelector('.document-workspace').textContent.includes('Recheck authentication')");
  assert.equal(await evaluate("!!document.querySelector('#document-body')"), false);
  await key("Escape", "Escape", 27); await pause(250);
  await click("Back to task list", "document.querySelector('.document-workspace header')");
  await wait("!document.querySelector('.document-workspace')"); await click("Documents");
  await wait("!!document.querySelector('[data-document-create-unknown]')");
  await evaluate(`fetch('/api/auth',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:'fictional-document-ui-fixture'})}).then(r=>r.ok)`);
  await click("Recheck authentication"); await wait("!document.querySelector('.document-workspace').textContent.includes('Recheck authentication')");
  record("Known Create 401 preserves an earlier unknown result and its no-editor sign-in return path");
  await click("Inspect document list");
  await wait("document.querySelector('[role=dialog][data-state=open]').textContent.includes('Fictional unknown create')");
  assert.equal((await evaluate("fetch('/__test/state').then(r=>r.json())")).createPosts, 2);
  await key("Escape", "Escape", 27); await pause(250);
  await click("Create document", "document.querySelector('.document-workspace header')");
  await evaluate("document.querySelector('[role=dialog][data-state=open] input[aria-label=\"Document title\"]').focus()");
  await send("Input.insertText", {text:"Fictional acknowledged create"});
  assert.ok(await evaluate("Array.from(document.querySelector('[role=dialog][data-state=open]').querySelectorAll('button')).find(b=>b.textContent==='Create document').disabled"));
  await evaluate("document.querySelector('[role=dialog][data-state=open] input[type=checkbox]').click()");
  await click("Create document", dialog);
  await wait("!!document.querySelector('#document-body') && !document.querySelector('[role=dialog][data-state=open]')");
  assert.ok(await evaluate("!!document.querySelector('[data-document-create-unknown]')"));
  assert.equal((await evaluate("fetch('/__test/state').then(r=>r.json())")).createPosts, 3);
  await click("Fictional LF SOP", "document.querySelector('.document-workspace')");
  await wait("document.querySelector('#document-title').value === 'Fictional LF SOP'");
  record("Committed Create with unknown response retains warning without editor and requires explicit duplicate-risk confirmation");
  await pause(100);
  const quotaBaseline = await evaluate("fetch('/__test/state').then(r=>r.json())");
  const original = await bodyValue();
  await evaluate("document.querySelector('#document-body').focus(); document.querySelector('#document-body').setSelectionRange(0,0)");
  await send("Input.insertText", { text: "Test " });
  assert.equal(await bodyValue(), `Test ${original}`);
  await key("z", "KeyZ", 90, 2); assert.equal(await bodyValue(), original);
  await key("z", "KeyZ", 90, 10); assert.equal(await bodyValue(), `Test ${original}`);
  record("Native trusted input and textarea Undo/Redo");
  await key("s", "KeyS", 83, 2);
  await wait("document.querySelector('.document-editor [role=status]').textContent === 'Saved'");
  await key("z", "KeyZ", 90, 2); assert.equal(await bodyValue(), original);
  await key("z", "KeyZ", 90, 10); assert.equal(await bodyValue(), `Test ${original}`);
  assert.ok(await evaluate("!!document.querySelector('[data-document-create-unknown]')"));
  assert.equal((await evaluate("fetch('/__test/state').then(r=>r.json())")).createPosts, 3);
  record("Ctrl+S saves through real Document API; native Undo survives save; unrelated save preserves Create warning");
  // Composition is simulated through CDP, not an operating-system IME acceptance test.
  await evaluate("document.querySelector('#document-body').focus(); document.querySelector('#document-body').setSelectionRange(0,0)");
  await send("Input.imeSetComposition", { text: "中文", selectionStart: 2, selectionEnd: 2 });
  await wait("document.querySelector('#document-body').value.startsWith('中文')");
  await send("Input.insertText", { text: "中文" }); await pause(100);
  assert.ok((await bodyValue()).startsWith("中文"));
  const committed = await bodyValue();
  await evaluate("document.querySelector('#document-body').setSelectionRange(0,0)");
  await send("Input.imeSetComposition", {text:"未完成", selectionStart:3, selectionEnd:3});
  await send("Input.imeSetComposition", {text:"", selectionStart:0, selectionEnd:0});
  await pause(100); assert.equal(await bodyValue(), committed);
  record("CDP Chinese composition commit/cancel (OS IME Not Verified)");
  await menu("Discard changes"); await click("Discard and continue", dialog);
  await click("Create document", "document.querySelector('.document-workspace header')");
  await wait("!!document.querySelector('[role=dialog][data-state=open] input')");
  await evaluate("document.querySelector('[role=dialog][data-state=open] input').focus()");
  await send("Input.insertText", { text: "Created Fictional SOP" });
  await evaluate("document.querySelector('[role=dialog][data-state=open] input[type=checkbox]').click()");
  await click("Create document", dialog);
  await wait("document.querySelector('#document-title').value === 'Created Fictional SOP' && !document.querySelector('[role=dialog][data-state=open]')");
  assert.equal(await bodyValue(), ""); await replaceBody("New fictional 中文😀\nbody");
  await key("s", "KeyS", 83, 2); await wait("document.querySelector('.document-editor [role=status]').textContent === 'Saved'");
  record("Create/open/edit a new empty LF document through the UI");
  // Open non-LF: confirmation only creates a local draft.
  await click("Fictional CRLF SOP", "document.querySelector('.document-workspace')");
  await wait("document.querySelector('#document-body').readOnly");
  assert.equal(await bodyValue(), "A\n\nB");
  const originalCR = await evaluate(`fetch('/api/documents/${setup.legacy}').then(r=>r.json())`);
  await evaluate("document.querySelector('#document-title').focus()"); await key("a", "KeyA", 65, 2);
  await send("Input.insertText", { text: "Fictional CRLF SOP renamed" });
  await click("Save", "document.querySelector('.document-editor')");
  await wait("document.querySelector('.document-editor [role=status]').textContent === 'Saved'");
  const before = await evaluate(`fetch('/api/documents/${setup.legacy}').then(r=>r.json())`);
  assert.equal(before.currentRevision.content, originalCR.currentRevision.content);
  assert.equal(await evaluate("document.querySelector('#document-body').readOnly"), true);
  record("Title-only save preserves canonical CRLF bytes and readonly gate");
  // Conversion is one explicit local click; it writes nothing until Save.
  await click("Convert and edit");
  assert.equal(await evaluate("!!document.querySelector('[role=dialog][data-state=open]')"), false);
  assert.equal(await evaluate("document.querySelector('#document-body').readOnly"), false);
  const unchanged = await evaluate(`fetch('/api/documents/${setup.legacy}').then(r=>r.json())`);
  assert.deepEqual(unchanged, before);
  record("CRLF readonly, one explicit convert click, conversion causes no HTTP write");
  await replaceBody("A");
  await evaluate("fetch('/__test/hold',{method:'POST'})");
  await click("Save", "document.querySelector('.document-editor')");
  await wait("document.querySelector('.document-editor [role=status]').textContent === 'Saving…'");
  await replaceBody("B");
  await evaluate("fetch('/__test/release',{method:'POST'})");
  await wait("document.querySelector('.document-editor [role=status]').textContent === 'Unsaved changes'");
  assert.equal(await bodyValue(), "B");
  const savedA = await evaluate(`fetch('/api/documents/${setup.legacy}').then(r=>r.json())`);
  assert.equal(savedA.currentRevision.content, "A");
  await menu("Discard changes"); await click("Discard and continue", dialog);
  assert.equal(await bodyValue(), "A"); assert.equal(await evaluate("document.querySelector('#document-body').readOnly"), false);
  record("Deferred PUT A/B rebase and discard to acknowledged LF snapshot");
  // Validate raw input remains visible rather than reverting to saved A.
  await replaceBody("x".repeat(262145));
  await wait("document.querySelector('#document-body').value.length === 262145");
  assert.ok(await evaluate("Array.from(document.querySelector('.document-editor').querySelectorAll('button')).find(b=>b.textContent==='Save').disabled"));
  await menu("Discard changes"); await click("Discard and continue", dialog);
  record("Oversized native input stays visible; save blocked; explicit discard");
  const current = await evaluate(`fetch('/api/documents/${setup.legacy}').then(r=>r.json())`);
  await evaluate(`fetch('/api/documents/${setup.legacy}', {method:'PUT', headers:{'content-type':'application/json'}, body:JSON.stringify({title:'Remote fictional SOP',contentFormat:'plain_text',content:'Remote content',expectedRevisionId:${JSON.stringify(current.currentRevision.id)}})}).then(r=>r.json())`);
  await replaceBody("Local conflict draft"); await click("Save", "document.querySelector('.document-editor')");
  await wait("document.querySelector('.document-editor [role=status]').textContent.includes('Revision conflict')");
  assert.equal(await bodyValue(), "Local conflict draft");
  await click("View server version"); await wait("!!document.querySelector('textarea[aria-label=\"Server version (read-only)\"]')");
  assert.equal(await bodyValue(), "Local conflict draft"); await key("Escape", "Escape", 27); await pause(250);
  await click("Discard draft and load latest"); await click("Discard and continue", dialog);
  await wait("document.querySelector('#document-body').value === 'Remote content'");
  record("Real CAS 409 keeps the local draft; remote preview and explicit reload");
  const beforeRestore = await evaluate(`fetch('/api/documents/${setup.legacy}').then(r=>r.json())`);
  await menu("Revision history"); await wait("!!document.querySelector('[role=dialog][data-state=open]')");
  await wait("Array.from(document.querySelector('[role=dialog][data-state=open]').querySelectorAll('button')).some(b=>b.textContent.includes('r1 ·'))");
  await evaluate("Array.from(document.querySelector('[role=dialog][data-state=open]').querySelectorAll('button')).find(b=>b.textContent.includes('r1 ·')).click()");
  await wait("!!document.querySelector('textarea[aria-label=\"Read-only revision preview\"]')");
  await wait("!!Array.from(document.querySelector('[role=dialog][data-state=open]').querySelectorAll('button')).find(b=>b.textContent==='Restore this revision')");
  await click("Restore this revision", dialog);
  await wait("Array.from(document.querySelector('[role=dialog][data-state=open]').querySelectorAll('button')).some(b=>b.textContent==='Confirm')");
  await click("Confirm", dialog);
  await wait("document.querySelector('#document-body').readOnly");
  await wait("document.querySelector('.document-editor [role=status]').textContent === 'Saved'");
  const restored = await evaluate(`fetch('/api/documents/${setup.legacy}').then(r=>r.json())`);
  assert.equal(restored.currentRevision.content, "A\r\n\rB"); assert.equal(restored.currentRevision.revisionNumber, beforeRestore.currentRevision.revisionNumber + 1);
  record("History preview, confirmed restore creates revision, CR gate returns");
  await screenshot("document-desktop");
  const quotaBeforeMobile = await evaluate("fetch('/__test/state').then(r=>r.json())");
  assert.equal(quotaBeforeMobile.runs, 0);
  assert.equal(quotaBeforeMobile.quotaCalls, quotaBaseline.quotaCalls);
  // Fresh mobile load creates the existing two-level history; memory draft survives Back/Forward.
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await send("Page.navigate", { url: `${origin}/?view=documents&document=${setup.first}` });
  await wait("!!document.querySelector('#document-body')"); await replaceBody("Mobile draft 中文😀");
  await evaluate("history.back()"); await pause(100); await evaluate("history.forward()");
  await wait("!document.querySelector('.document-workspace').hidden"); assert.equal(await bodyValue(), "Mobile draft 中文😀");
  assert.ok(await evaluate("document.documentElement.scrollWidth <= window.innerWidth"));
  await send("Emulation.setDeviceMetricsOverride", { width: 320, height: 568, deviceScaleFactor: 1, mobile: true });
  assert.ok(await evaluate("document.documentElement.scrollWidth <= window.innerWidth"));
  await screenshot("document-mobile-320");
  record("390px/320px layout and mobile Browser Back/Forward preserve draft");
  await send("Network.clearBrowserCookies"); await evaluate("document.querySelector('#document-body').focus()"); await key("s", "KeyS", 83, 2);
  await wait("document.querySelector('.document-workspace').textContent.includes('Recheck authentication')");
  assert.equal(await bodyValue(), "Mobile draft 中文😀");
  await evaluate(`fetch('/api/auth',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:'fictional-document-ui-fixture'})}).then(r=>r.ok)`);
  await click("Recheck authentication");
  await wait("!document.querySelector('.document-workspace').textContent.includes('Recheck authentication')");
  assert.equal(await bodyValue(), "Mobile draft 中文😀");
  const retained = await evaluate("JSON.stringify({url:location.href,history:history.state,storage:Object.entries(localStorage),session:Object.entries(sessionStorage)})");
  assert.equal(retained.includes("Mobile draft"), false);
  assert.equal(browserLogs.some(message=>message.includes("Mobile draft")), false);
  record("Real cookie 401/recheck retain draft without URL/storage/console leakage");
  const state = await evaluate("fetch('/__test/state').then(r=>r.json())"); assert.equal(state.runs, 0);
  // PR 1C-B: all subsequent interactions use the same isolated backend and fictional documents.
  await send("Emulation.setDeviceMetricsOverride", { width: 1360, height: 950, deviceScaleFactor: 1, mobile: false });
  const createFictional = async (title, content) => evaluate(`fetch('/api/documents',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(${JSON.stringify({title,contentFormat:"plain_text",content})})}).then(r=>r.json())`);
  const docA = await createFictional("Fictional Suggestions A", "same\n中文😀\nsame\nFictional ending.");
  const docB = await createFictional("Fictional Suggestions B", "Other fictional document.");
  const load = async id => {
    await evaluate("window.__fixturePreviousPage = true");
    await send("Page.navigate", {url:`${origin}/?view=documents&document=${id}`});
    await wait("!window.__fixturePreviousPage && document.readyState === 'complete' && !!document.querySelector('#document-body')");
  };
  const readDocument = async id => evaluate(`fetch('/api/documents/${id}').then(r=>r.json())`);
  const fixtureState = () => evaluate("fetch('/__test/state').then(r=>r.json())");
  const mode = value => evaluate(`fetch('/__test/suggestion-mode',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:${JSON.stringify(value)}})})`);
  const fill = async (selector,text) => { await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`); await key("a","KeyA",65,2); await send("Input.insertText",{text}); await pause(80); };
  const selectPassage = async (start,end) => {
    await evaluate(`(() => {const e=document.querySelector('#document-body');e.focus();e.setSelectionRange(${start},${end});e.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));})()`);
    await pause(100);
  };
  const startPrompt = async (start,end) => { await selectPassage(start,end); await click("Revise selection", "document.querySelector('.document-editor')"); await wait("!!document.querySelector('#suggestion-instructions')"); };
  const buildPrompt = async (toResult = true) => {
    await fill('#suggestion-instructions','Improve clarity 中文, preserving all facts.'); await click('Next',dialog);
    await wait("!!document.querySelector('[data-suggestion-step=\"2\"]')");
    if (toResult) { await click('I have the result',dialog); await wait("!!document.querySelector('#suggestion-replacement')"); }
  };
  const openSuggestions = () => menu('Suggestions');
  const importCandidate = async text => { await fill('#suggestion-replacement',text); await click('Create suggestion',dialog); await wait("!!document.querySelector('[data-suggestion-detail]')"); return evaluate("document.querySelector('[data-suggestion-detail]').getAttribute('data-suggestion-detail')"); };
  const closeReview = async () => { await key('Escape','Escape',27); await wait("!document.querySelector('[role=dialog][data-state=open]')"); await pause(250); };
  await load(docA.id);
  await startPrompt(5,9);
  assert.ok(await evaluate("document.querySelector('[data-suggestion-original]').textContent==='中文😀'"));
  await buildPrompt(false);
  const promptValue = await evaluate("document.querySelector('#suggestion-prompt').value");
  assert.ok(promptValue.includes('中文😀')); assert.ok(promptValue.includes('r1'));
  assert.ok(!promptValue.includes(docA.id)); assert.ok(!promptValue.includes(docA.currentRevision.id)); assert.ok(!promptValue.includes('utf16_code_units'));
  assert.equal((await readDocument(docA.id)).currentRevision.revisionNumber,1);
  record('Frozen Chinese/emoji UTF-16 selection and bounded prompt preview exclude internal UUIDs/offsets by default; preview writes nothing');
  await evaluate(`(() => {window.__fixtureClipboard=Object.getOwnPropertyDescriptor(navigator,'clipboard');window.__fixtureSecure=Object.getOwnPropertyDescriptor(window,'isSecureContext');Object.defineProperty(window,'isSecureContext',{configurable:true,value:true});Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{}}});})()`);
  await click('Copy prompt',dialog); await wait("document.querySelector('[role=dialog][data-state=open]').textContent.includes('Prompt copied.')");
  await evaluate("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw new Error('Fixture copy denied')}}})");
  await click('Copy prompt',dialog); await wait("document.querySelector('[role=dialog][data-state=open]').textContent.includes('Copy failed.')");
  await evaluate("document.querySelector('[data-suggestion-prompt-details]').open=true"); await pause(50);
  await click('Select all prompt text',dialog);
  assert.ok(await evaluate("document.activeElement.id==='suggestion-prompt' && document.activeElement.selectionStart===0 && document.activeElement.selectionEnd===document.activeElement.value.length"));
  for(let i=0;i<8;i++) await key('Tab','Tab',9);
  assert.ok(await evaluate("document.querySelector('[role=dialog][data-state=open]').contains(document.activeElement)"));
  await key('s','KeyS',83,2); assert.equal((await readDocument(docA.id)).currentRevision.revisionNumber,1);
  record('Clipboard success/refusal, visible select-all fallback, dialog focus trap and Ctrl+S guard');
  await evaluate(`(() => {if(window.__fixtureClipboard)Object.defineProperty(navigator,'clipboard',window.__fixtureClipboard);else delete navigator.clipboard;if(window.__fixtureSecure)Object.defineProperty(window,'isSecureContext',window.__fixtureSecure);else delete window.isSecureContext;delete window.__fixtureClipboard;delete window.__fixtureSecure;})()`);
  await click('I have the result',dialog); await wait("!!document.querySelector('#suggestion-replacement')");
  await evaluate(`(() => {const dt=new DataTransfer();dt.setData('text/plain',${JSON.stringify("Candidate\r\nline")});document.querySelector('#suggestion-replacement').dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));})()`);
  await wait("document.querySelector('#suggestion-replacement').readOnly");
  assert.ok(await evaluate("Array.from(document.querySelector('[role=dialog][data-state=open]').querySelectorAll('button')).find(b=>b.textContent==='Create suggestion').disabled"));
  await click('Convert candidate to LF',dialog); await click('Confirm',dialog);
  assert.equal(await evaluate("document.querySelector('#suggestion-replacement').value"),'Candidate\nline');
  assert.equal((await readDocument(docA.id)).currentRevision.revisionNumber,1);
  record('CR paste is retained/blocked and converts only after explicit local confirmation, with no document write');
  const replacement='Revised 中文😀\nCandidate.';
  await fill('#suggestion-replacement',replacement); await mode('lose-import');
  const beforeImport=(await fixtureState()).suggestionPosts.import;
  await click('Create suggestion',dialog); await wait("!!document.querySelector('[data-suggestion-unknown]')");
  assert.equal((await fixtureState()).suggestionPosts.import,beforeImport+1);
  await click('Check suggestion outcome',dialog); await wait("!!document.querySelector('[data-suggestion-detail]')");
  const sid=await evaluate("document.querySelector('[data-suggestion-detail]').getAttribute('data-suggestion-detail')");
  assert.equal((await fixtureState()).suggestionPosts.import,beforeImport+1); assert.equal((await readDocument(docA.id)).currentRevision.revisionNumber,1);
  await wait("!!document.querySelector('[data-suggestion-monaco] .monaco-diff-editor')");
  record('Unknown Import reconciles the original key through metadata/detail without repost; desktop read-only Monaco diff loads locally');
  await mode('lose-accept'); const beforeAccept=(await fixtureState()).suggestionPosts.accept;
  await click('Accept suggestion',dialog); assert.equal((await readDocument(docA.id)).currentRevision.revisionNumber,1);
  await click('Confirm accept',dialog); await wait("!!document.querySelector('[data-suggestion-unknown]')");
  assert.equal(await evaluate("document.querySelector('#document-body').readOnly"),true); assert.equal(await evaluate("document.querySelector('#document-title').disabled"),true);
  await click('Check suggestion outcome',dialog); await wait("!!document.querySelector('[data-suggestion-receipt]') && !document.querySelector('[data-suggestion-unknown]')");
  const a2=await readDocument(docA.id); assert.equal(a2.currentRevision.content,`same\n${replacement}\nsame\nFictional ending.`); assert.equal(a2.currentRevision.revisionNumber,2);
  assert.equal((await fixtureState()).suggestionPosts.accept,beforeAccept+1);
  record('Accept response lost after commit: GET receipt/current restores editor, keeps permanent receipt and never repeats Accept');
  await closeReview();
  const secondStart=10+replacement.length-4;
  await startPrompt(secondStart,secondStart+4); await buildPrompt(); await importCandidate('Only the second occurrence');
  await mode('defer-accept'); const pendingAcceptCount=(await fixtureState()).suggestionPosts.accept;
  await click('Accept suggestion',dialog); await click('Confirm accept',dialog); await wait("!!document.querySelector('[data-suggestion-unknown]')");
  await click('Check suggestion outcome',dialog); await pause(100);
  assert.ok(await evaluate("!!document.querySelector('[data-suggestion-unknown]')")); assert.equal(await evaluate("document.querySelector('#document-body').readOnly"),true);
  assert.equal((await readDocument(docA.id)).currentRevision.revisionNumber,2);
  await evaluate("fetch('/__test/release-suggestion',{method:'POST'})"); await click('Check suggestion outcome',dialog);
  await wait("!document.querySelector('[data-suggestion-unknown]') && !!document.querySelector('[data-suggestion-receipt]')");
  const a3=await readDocument(docA.id); assert.equal(a3.currentRevision.content,`same\n${replacement}\nOnly the second occurrence\nFictional ending.`);
  assert.equal((await fixtureState()).suggestionPosts.accept,pendingAcceptCount+1);
  record('Pending GET cannot clear unknown Accept; releasing original request applies only the second repeated-text range once');
  await closeReview(); await startPrompt(0,4); await buildPrompt();
  const untrusted='<script>window.__suggestionInjected=true</script>\n```';
  const rejectId=await importCandidate(untrusted);
  assert.equal(await evaluate('window.__suggestionInjected === undefined'),true);
  await closeReview();
  const getSuggestion=async id=>evaluate(`fetch('/api/documents/${docA.id}/suggestions/${id}').then(r=>r.json())`);
  assert.equal((await getSuggestion(rejectId)).status,'pending');
  await openSuggestions(); await wait(`!!document.querySelector('[data-suggestion-id="${rejectId}"]')`);
  await evaluate(`document.querySelector('[data-suggestion-id="${rejectId}"]').click()`); await wait(`document.querySelector('[data-suggestion-detail]')?.getAttribute('data-suggestion-detail')===${JSON.stringify(rejectId)}`);
  await click('Reject suggestion',dialog); await click('Confirm reject',dialog);
  await wait("document.querySelector('[data-suggestion-detail]').textContent.includes('Rejected')");
  assert.deepEqual(await readDocument(docA.id),a3); assert.equal((await getSuggestion(rejectId)).replacementText,untrusted);
  record('Untrusted HTML/fences stay literal; closing is not Reject; explicit Reject preserves exact document/revision');
  await closeReview(); await startPrompt(0,4); await buildPrompt(); const staleId=await importCandidate('Stale proposal');
  await evaluate(`fetch('/api/documents/${docA.id}',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({title:'Fictional Suggestions A',contentFormat:'plain_text',content:'Remote fictional version',expectedRevisionId:${JSON.stringify(a3.currentRevision.id)}})}).then(r=>r.json())`);
  await click('Accept suggestion',dialog); await click('Confirm accept',dialog);
  await wait("document.querySelector('[role=dialog][data-state=open]').textContent.includes('saved version or operation state changed')");
  assert.equal((await readDocument(docA.id)).currentRevision.content,'Remote fictional version');
  assert.equal((await getSuggestion(staleId)).status,'pending');
  assert.ok(await evaluate("Array.from(document.querySelector('[role=dialog][data-state=open]').querySelectorAll('button')).find(b=>b.textContent==='Accept suggestion').disabled"));
  record('Real stale CAS 409 retains the suggestion and disables another Accept without substituting current revision');
  await closeReview(); await load(docA.id); await openSuggestions();
  await wait(`!!document.querySelector('[data-suggestion-id="${sid}"]')`); await evaluate(`document.querySelector('[data-suggestion-id="${sid}"]').click()`);
  await wait("!!document.querySelector('[data-suggestion-receipt]')");
  assert.ok(await evaluate("document.querySelector('[data-suggestion-receipt]').textContent.includes('r2')"));
  assert.ok(await evaluate("document.querySelector('[data-suggestion-detail]').textContent.includes('current document r4')"));
  record('Reload recovers persisted suggestions and shows accepted r2 receipt independently of last confirmed current r4');
  await closeReview(); await mode('hold-detail-fail'); await openSuggestions();
  await wait(`!!document.querySelector('[data-suggestion-id="${sid}"]')`); await evaluate(`document.querySelector('[data-suggestion-id="${sid}"]').click()`);
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await (await fetch(`${origin}/__test/state`)).json()).heldSuggestionDetail) break;
    await pause(50);
  }
  assert.equal((await (await fetch(`${origin}/__test/state`)).json()).heldSuggestionDetail,true);
  await closeReview(); await click('Fictional Suggestions B',"document.querySelector('.document-workspace')");
  await wait("document.querySelector('#document-title').value==='Fictional Suggestions B'");
  await evaluate("fetch('/__test/release-suggestion',{method:'POST'})"); await pause(250);
  assert.equal(await bodyValue(),'Other fictional document.'); assert.ok(!await evaluate("document.querySelector('.document-workspace').textContent.includes('Unable to confirm the suggestion result')"));
  record('Late A detail failure after opening B cannot change B or show A error');
  await load(docA.id); await evaluate("window.__fixtureWorker=window.Worker;window.Worker=class {constructor(){throw new Error('Fixture worker unavailable')}}");
  await openSuggestions(); await wait(`!!document.querySelector('[data-suggestion-id="${sid}"]')`);
  await evaluate(`document.querySelector('[data-suggestion-id="${sid}"]').click()`); await wait("!!document.querySelector('[data-suggestion-plain]')");
  await wait("document.querySelector('[role=dialog][data-state=open]').textContent.includes('diff editor is unavailable')");
  await evaluate("window.Worker=window.__fixtureWorker;delete window.__fixtureWorker");
  record('Local Monaco worker construction failure falls back to read-only plaintext comparison');
  await closeReview();
  for(const width of [390,320]) {
    await send('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:true});
    await openSuggestions(); await wait(`!!document.querySelector('[data-suggestion-id="${sid}"]')`);
    await evaluate(`document.querySelector('[data-suggestion-id="${sid}"]').click()`); await wait("!!document.querySelector('[data-suggestion-plain]')");
    await click('Candidate passage',dialog); assert.equal(await evaluate("document.querySelector('textarea[aria-label=\"Candidate passage\"]').value"),replacement);
    assert.ok(await evaluate("document.documentElement.scrollWidth<=window.innerWidth"));
    assert.ok(await evaluate("Array.from(document.querySelectorAll('[data-suggestion-review], [data-suggestion-plain], [role=dialog][data-state=open]')).every(e=>e.scrollWidth<=e.clientWidth+1)"), 'Review panels must not scroll horizontally');
    await screenshot(`suggestions-mobile-${width}`); await closeReview();
  }
  record('390px/320px review defaults to selectable original/candidate plaintext with responsive controls');
  await replaceBody('Dirty proposal gate'); await selectPassage(0,5);
  assert.ok(await evaluate("document.querySelector('[data-suggestion-gate]').textContent.includes('unsaved changes')"));
  assert.ok(await evaluate("Array.from(document.querySelector('.document-editor').querySelectorAll('button')).find(b=>b.textContent==='Revise selection').disabled"));
  await menu('Discard changes'); await click('Discard and continue',dialog);
  await load(setup.legacy); await selectPassage(0,1);
  assert.ok(await evaluate("Array.from(document.querySelector('.document-editor').querySelectorAll('button')).find(b=>b.textContent==='Revise selection').disabled"));
  record('Dirty and restored CR canonical documents cannot create a suggestion intent');
  const privacy=await evaluate("JSON.stringify({url:location.href,history:history.state,storage:Object.entries(localStorage),session:Object.entries(sessionStorage)})");
  assert.ok(!privacy.includes(replacement)); assert.ok(!privacy.includes(untrusted)); assert.ok(!browserLogs.some(x=>x.includes(replacement)||x.includes(untrusted)));
  assert.ok(networkUrls.every(url=>url.startsWith(origin)||url.startsWith(`blob:${origin}`)||url.startsWith('data:')||url==='about:blank'), 'Unexpected non-loopback browser request');
  const finalState=await fixtureState(); assert.equal(finalState.runs,0); assert.equal(finalState.quotaCalls,quotaBaseline.quotaCalls);
  record('All suggestion interactions use only loopback; no model runs, extra quota calls, content in storage/URL/history/logs');
  console.log(JSON.stringify({ passed: results, fakeAdapterRuns: state.runs, fakeQuotaCalls: state.quotaCalls,
    notVerified: ["Physical OS Chinese IME variants/cancellation", "Physical mobile virtual keyboard", "Safari/Firefox", "Cmd+S on macOS"] }, null, 2));
} finally {
  const fixtureStopped = once(fixture, "exit"), chromeStopped = once(chrome, "exit");
  fixture.kill("SIGTERM");
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({id:2147483647,method:"Browser.close"}));
  await Promise.race([chromeStopped, pause(2000)]);
  if (chrome.exitCode === null) chrome.kill("SIGTERM");
  socket?.close();
  await Promise.race([fixtureStopped, pause(3000)]);
  await Promise.race([chromeStopped, pause(3000)]);
  fs.closeSync(log); fs.copyFileSync(path.join(profile, "chrome.log"), path.join(os.tmpdir(), "document-ui-chrome-last.log")); try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { console.error("Fixture profile cleanup incomplete", profile); }
}
