# Speech-to-speech experiment ("Summit Air – S2S")

A **separate** test assistant that runs the same job on a speech-to-speech model, so it can be compared with the production pipeline (Deepgram → GPT-4.1 → Vapi voice) by ear and by numbers. It never touches the live assistant or the published phone number.

## What it is

`vapi/targets/s2s.json`, managed with:

```bash
npm run vapi:sync -- --target s2s --dry-run   # shows "would create" until it exists
npm run vapi:sync -- --target s2s             # first run creates it and prints VAPI_S2S_ASSISTANT_ID=…; add that to .env
npm run vapi:sync -- --target s2s             # later runs update it (and publish a new version of it, not of the main assistant)
```

- **Model:** OpenAI Realtime `gpt-realtime-2` (docs.vapi.ai/openai-realtime), the model Vapi recommends for native speech-to-speech. Audio goes in and out with no separate transcriber or TTS, so the transcriber is removed.
- **Voice:** OpenAI `marin` (others: `alloy`, `echo`, `shimmer`, `cedar`). Voice variants (`--voice`) don't apply.
- **Same as main:** the 7 tools (same Vapi tool ids, same `/api/vapi/tools` endpoint and credential), the events server URL (end-of-call reports, keep-warm), `phone-call-control` tail padding, the `endCall` goodbye and end-call phrase, and the same prompt template.
- **Prompt differences** (`<<#S2S>>` sections in `vapi/system-prompt.md`):
  - The safety script is said word for word, at a calm pace.
  - A short opener ("One sec.") before each tool call, because tool filler messages may not be spoken in speech-to-speech.
  - Addresses, ZIPs and phone numbers are read back before use, since the model hears audio, not a transcript.
  - English only unless the caller doesn't speak it; never switch because of an accent.
  - Everything else is identical. A test checks which lines differ.

## What's unsupported or different, and the mitigations

| Area | Production pipeline | S2S (Realtime) | Mitigation |
|---|---|---|---|
| **Exact-phrase safety script** | Text the model writes, spoken by TTS; wording is controllable | The model generates speech directly and may paraphrase | S2S prompt: "Say it word for word… don't shorten, reorder or paraphrase it." Checked on every test call (checklist below). If it paraphrases, S2S isn't safe for production |
| **Endpointing controls** | Flux `eotThreshold` / `eotTimeoutMs`, `waitSeconds`, `stopSpeakingPlan` | Turn detection "managed by Vapi's orchestration layer"; our endpointing settings don't apply | None to tune. Measure cut-ins and waits with `call-report` |
| **Transcript fidelity** | Deepgram transcript with keyterms (brand and street names) | Transcripts "may have slight differences" from what was said; no keyterms | Read-back of addresses and numbers before tool calls; the backend's address matcher already tolerates spoken forms |
| **Tool timing** | Tool fires after the model's text turn; a request-start filler covers the wait | Same webhook and tools; filler messages may not play | The model says "One sec." itself before tools (S2S prompt) |
| **Voice choice** | Any Vapi, Cartesia or ElevenLabs voice; "Ayva" respelling via `formatPlan` | OpenAI voices only; no TTS text pipeline, so `formatPlan` replacements don't apply | "Ava" pronunciation can't be forced; listen for it |
| **Goodbye** | `endCall` message + padded hang-up | Same config; GPT-Live docs warn the goodbye "may be cut off" when `endCall` fires | The same `phone-call-control` tail padding applies, since the hang-up is still delegated to our server |
| **Cost** | Per-minute transcriber + LLM tokens + TTS | Realtime audio tokens (typically higher per minute) | Test only; don't route real traffic |

**Option B, GPT-Live (beta).** Vapi's newer speech-to-speech architecture: `model.model: "gpt-live-1"` with a `speaker` and a `reasoner` (e.g. `gpt-5.6-terra`) that runs the tools.
- It isn't the default target because:
  - Vapi documents its phone connections as native Twilio and Vapi SIP, and it doesn't say whether a free Vapi number works;
  - tool request-start messages are never spoken;
  - `firstMessage` is generated, not verbatim;
  - start/stop speaking plans are ignored.
- If you want to try it, copy `vapi/targets/s2s.json` to `s2s-live.json` with that model block and a new `assistantIdEnv`, and test it from the dashboard's Talk button first.

## Calling it safely

Never reassign the published number (347) 719-8328.

1. **Dashboard "Talk" button** (no phone): open the S2S assistant in the Vapi dashboard and talk in the browser. Good for a first check, but browser audio isn't the phone path.
2. **A second Vapi number:**
   - Vapi gives one free US number per account, and you already use it.
   - On a plan with more numbers, create one for the S2S assistant: `POST /phone-number {"provider":"vapi","numberDesiredAreaCode":"347","assistantId":"<VAPI_S2S_ASSISTANT_ID>"}` (or Phone Numbers → Create in the dashboard).
   - It's inbound-only, so call it from your phone.
3. **Not recommended: traffic splitting.** `POST /traffic-allocations` splits calls between *versions of one assistant*, and is sticky by caller number. The S2S assistant is a different assistant, and a split would expose real callers to the experiment.

## Side-by-side checklist

Make the same scripted call to both, for example "As Priya: my AC is out, my grandmother lives with me", then book, then hang up. After each, run `npm run call-report -- latest` for main and `npm run call-report -- latest --target s2s` for the S2S assistant (or pass a call id).

| Check | Main (pipeline) | S2S |
|---|---|---|
| Median / p95 caller-stop → Ava-start (call-report) | | |
| Overlaps (cut-ins) count | | |
| Naturalness (1–5): pacing, warmth, interruptions handled | | |
| Tool correctness: `lookup_customer` verified, `triage_issue` urgency right, booking lands on `/appointments` with full notes | | |
| Safety script word for word (run a separate "I smell gas" call) | | |
| Address and phone read-back correct | | |
| "Ava" pronounced AY-vuh | | |
| Goodbye complete on the phone, no clipping | | |
| Cost per minute (Vapi call cost) | | |
