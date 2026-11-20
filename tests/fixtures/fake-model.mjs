#!/usr/bin/env node
// A stand-in model endpoint (OpenAI chat completions, streamed) for tests that need a model to answer, fail or hang
// on cue, without a paid provider. The model id says what it does:
//   ok            answers "FAKE_OK"
//   slow-<ms>     waits <ms>, then answers "FAKE_OK"
//   503           answers 503 at once (a transient server error: Pi retries it)
//   slow503-<ms>  waits <ms>, then 503
// Prints its port on stdout, then serves until killed. Each request is appended to $FAKE_MODEL_LOG if set.
import http from "node:http";
import fs from "node:fs";

const server = http.createServer((req, res) => {
	let body = "";
	req.on("data", d => { body += d; });
	req.on("end", async () => {
		let model = "ok";
		try { model = JSON.parse(body).model ?? "ok"; } catch { /* */ }
		if (process.env.FAKE_MODEL_LOG) fs.appendFileSync(process.env.FAKE_MODEL_LOG, JSON.stringify({ at: Date.now(), model }) + "\n");
		const m = /^(slow503|slow)-(\d+)$/.exec(model);
		if (m) await new Promise(r => setTimeout(r, Number(m[2])));
		if (model === "503" || m?.[1] === "slow503") { res.writeHead(503, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "overloaded", type: "server_error" } })); return; }
		res.writeHead(200, { "content-type": "text/event-stream" });
		const chunk = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
		chunk({ role: "assistant", content: "FAKE_OK" });
		chunk({}, "stop");
		res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
		res.end("data: [DONE]\n\n");
	});
});
server.listen(0, "127.0.0.1", () => { console.log(server.address().port); });
