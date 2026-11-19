// `pnpm images`: build every container image Agent Hub uses, so the first task does not wait for it.
import { ensureImage } from "../src/docker/images";
import * as codex from "../src/agents/codex-docker";
import { MEDIA_IMAGE } from "../src/media/video";

const media = await ensureImage(MEDIA_IMAGE);
console.log(`media: ${media.tag} (${media.built ? "built" : "already present"})`);
const c = await codex.ensureImage();
console.log(`codex: ${codex.imageTag()} (${c.built ? "built" : "already present"})`);
