#!/usr/bin/env node
// A stand-in for "some other coding agent" (Claude Code, Codex) behind the command-runner contract (RUNNERS.md):
// started in a terminal with its first prompt as an argument, it calls its configured hooks, as such an agent's
// hook system would, at session start, prompt submit, after each answer and at the end of its turn. It runs no
// model. What it does is chosen by FAKE_SCRIPT, one word per step:
//   report      call bin/loop-run.mjs report (findings false, summary FAKE_OK)
//   report-ask  report findings true with an ask
//   work        say a tool ran and wait 1s
//   dialog      say it waits on a person, then wait (a dialog nobody answers)
//   hang        go silent forever, working
//   crash       exit 3 mid-turn
//   error       answer with a model error twice (as an agent that retried and gave up)
//   stay        after its turn, stay open (an interactive session waiting for more)
// Hooks come from the settings file its runner wrote into the run's channel (FAKE_SETTINGS, a path).
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const settings = JSON.parse(fs.readFileSync(process.env.FAKE_SETTINGS || process.argv[2], "utf8"));
const prompt = process.argv[3] ?? "";
const steps = (process.env.FAKE_SCRIPT || "report").split(/\s+/);
const sessionId = `fake-${process.pid}`;
const hook = (name, payload = {}) => {
	for (const cmd of settings.hooks?.[name] ?? []) {
		try { execFileSync("sh", ["-c", cmd], { input: JSON.stringify({ session_id: sessionId, hook_event_name: name, ...payload }), stdio: ["pipe", "inherit", "inherit"] }); } catch { /* a hook's failure */ }
	}
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const loopRun = process.env.FAKE_LOOP_RUN;

console.log(`fake agent: ${prompt.split("\n")[0].slice(0, 80)}`);
hook("SessionStart", { model: "fake/one" });
hook("UserPromptSubmit", { prompt });
for (const step of steps) {
	if (step === "report") execFileSync("node", [loopRun, "report", "--findings", "false", "--summary", "FAKE_OK"], { stdio: "inherit" });
	if (step === "report-ask") execFileSync("node", [loopRun, "report", "--findings", "true", "--summary", "FAKE_FOUND", "--ask", "Approve the fake"], { stdio: "inherit" });
	if (step === "work") { hook("PostToolUse", {}); await sleep(1000); }
	if (step === "dialog") { hook("Notification", { message: "Allow the fake to write?" }); await sleep(10 * 60_000); }
	if (step === "hang") await sleep(24 * 60 * 60_000);
	if (step === "crash") process.exit(3);
	if (step === "error") { hook("Answer", { stop: "error" }); hook("Answer", { stop: "error" }); }
}
hook("Stop", { last_assistant_message: "fake turn done" });
if (steps.includes("stay")) await sleep(24 * 60 * 60_000);
hook("SessionEnd", {});
