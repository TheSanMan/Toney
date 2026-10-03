# ADR 006: ChatGPT plan inference in the desktop agent

Status: Implemented for personal prototype; live account catalog and native tone inference verified. Packaged GUI lifecycle acceptance remains.

## Decision

Use the documented direct OAuth flow for eligible locally hosted open-source apps. Toney requests explicit permission to use the signed-in user's ChatGPT plan. This needs neither a partner API key nor a client secret. It does not use ChatGPT web session cookies or private backend endpoints.

The frontend receives account display information, available model slugs/names, sanitized errors, and completed tone interpretations. Credentials and callback URLs remain in Rust. Model discovery calls `GET https://api.openai.com/v1/models` with the same access token as inference, preserves catalog ordering, and displays only `visibility: list` entries. Account access is discovered after sign-in, not inferred from Codex's current model. The default preference is discovered GPT-6 Astra, then GPT-6.1 Sol, then the first account-listed model; a valid explicit user selection is preserved. No model is represented as having unlimited usage.

## Authorization and storage

- Bind `127.0.0.1` on an available port before opening the system browser. Use `/auth/callback` throughout, with the identical redirect URI in each code exchange.
- Fresh cryptographic state, nonce and PKCE S256 verifier are bound to each attempt; mismatches and duplicate callback parameters cannot consume it. The listener expires after ten minutes and stops after cancellation.
- First registration uses `dynamic_agent_client`, `agent_name_hint=Toney`, and a stable `urn:uuid:<UUIDv4>` installation host identifier. On upgrade, the unsupported checkpoint008 `toney:` seed is atomically migrated to a deterministic UUIDv4 URI; valid saved UUID IDs are reused and account records are preserved. The issued callback client ID is used for code exchange. Returning sign-ins reuse the saved issued registration and verify the original subject.
- Verify the ID token signature using OpenAI's published JWKS and ring's RS256 verification. Validate issuer, audience, expiry, issue time, optional not-before, authorized party for multiple audiences and original nonce. Reject unsigned and symmetric JWT algorithms.
- Require granted `openid`, `resource.invoke` and `chatgpt.tokens.use.direct` scopes before inference. Identity-only sign-in cannot enable the agent.
- Store host identity, registration mapping and credentials separately under the application data directory's `chatgpt` folder. The directory is `0700` and atomic credential files are `0600` on Unix. Refuse symlink files and unprotected stored records. Files are outside the repository and never part of exports or diagnostics. This follows the official protected-file route; it does not currently use macOS Keychain. The prototype supports one saved account/workspace registration at a time.
- Serialize rotating refreshes within the desktop process, atomically replace credentials, and reject results after account generation changes. Multiple simultaneous Toney instances are outside this prototype's acceptance scope.
- Sign-out clears local tokens, retains host/account registration, and attempts remote session revocation via OpenID discovery. If remote revocation cannot be confirmed, show an explicit notice linking the user to ChatGPT settings.

## Inference

`POST https://api.openai.com/v1/responses` uses `store:false`, `stream:true`, an input array and instructions, with a strict tone interpretation JSON schema. No unsupported system input message, temperature, max-output field or persistent previous-response ID is sent. SSE is parsed incrementally across fragmented UTF-8/network chunks, with bounded response size. Requests explicitly advertise `Accept: text/event-stream`. The live plan-usage route has returned valid SSE without `Content-Type`; Toney accepts missing media metadata while still requiring parsed SSE, terminal completion and strict tone schema. An explicitly incompatible media type is rejected. Completion, structure and numeric bounds must validate before a rig can change. Provider errors never trigger a silent offline substitution.

The request contains the user's description, perceptual baseline and optional current rig descriptor. Guitar audio stays local. The model cannot hear the audition or import ChatGPT conversations/memory. Existing tone compilation remains deterministic; this checkpoint improves interpretation and engineering explanation, not an autonomous gear-selection loop.

## Validation and acceptance

Automated coverage includes bound OAuth URLs, callback state/client identity, JWT signatures and claim rejection, model visibility/order, granted scopes, protected atomic storage, allowed payload fields, fragmented SSE and failed/incomplete inference. Live account discovery and a GPT-6 Astra request using the production Rust request/parser completed with valid tone intent on 2026-10-03. The opt-in ignored test `live_account_completes_production_tone_interpretation` reads a protected file path supplied through `TONEY_CHATGPT_ACCEPTANCE_CREDENTIALS`, does not refresh credentials externally, and prints transport/schema evidence only. Normal CI never reads account credentials. User acceptance still includes packaged GUI generation, restart/reconnect and sign-out. Public preview behavior may change independently of the app.

## Official references

- [Accepted host ID formats](https://developers.openai.com/siwc/token-sharing-open-source)
- [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [ID-token verification](https://developers.openai.com/siwc/website)
