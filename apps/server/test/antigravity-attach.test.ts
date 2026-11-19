import http from "node:http";
import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { DockerRuntime } from "../src/antigravity/docker";
afterEach(() => vi.restoreAllMocks());
it("attaches a writable upgraded Engine TTY and resizes it without host stdin", async () => {
  const socket = Object.assign(new EventEmitter(), { write: vi.fn(() => true), destroy: vi.fn(), destroyed: false, writableLength: 0 });
  const requests: http.RequestOptions[] = [];
  const request = vi.spyOn(http, "request").mockImplementation(((options: http.RequestOptions, callback?: (response: EventEmitter & { statusCode: number; resume: () => void }) => void) => {
    requests.push(options);
    const req = Object.assign(new EventEmitter(), { setTimeout: vi.fn(), destroy: vi.fn(), end: () => {
      if (options.path?.includes("/attach?")) req.emit("upgrade", {}, socket, Buffer.from("first-screen"));
      else {
        const response = Object.assign(new EventEmitter(), { statusCode: 200, resume: () => queueMicrotask(() => response.emit("end")) });
        callback?.(response);
      }
    } });
    return req;
  }) as unknown as typeof http.request);
  class ScriptedDocker extends DockerRuntime {
    commands: string[][] = [];
    protected override async command(args: string[]) { this.commands.push(args); return ""; }
  }
  const runtime = new ScriptedDocker(); const output = vi.fn();
  const attachment = await runtime.attach("fake-container", output, vi.fn());
  expect(requests[0]).toMatchObject({ socketPath: "/var/run/docker.sock", method: "POST", headers: { Connection: "Upgrade", Upgrade: "tcp" } });
  expect(requests[0]?.path).toBe("/containers/fake-container/attach?stream=1&stdin=1&stdout=1&stderr=1");
  expect(output).toHaveBeenCalledWith(Buffer.from("first-screen"));
  socket.emit("data", Buffer.from("next-screen"));
  expect(output).toHaveBeenCalledWith(Buffer.from("next-screen"));
  attachment.write("code\r"); expect(socket.write).toHaveBeenCalledWith("code\r");
  await runtime.start("fake-container", new AbortController().signal);
  expect(runtime.commands).toEqual([["start", "fake-container"]]);
  expect(requests[1]?.path).toBe("/containers/fake-container/resize?h=30&w=300");
  attachment.close(); expect(socket.destroy).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledTimes(2);
});
