# ADR 005 — TONE3000 selection and local downloads

Status: accepted for the personal prototype.

## Decision

Use TONE3000's hosted OAuth `select_tone` flow to browse and audition compatible gear. Toney's publishable application identifier is embedded in the native client. It identifies Toney; it is not an account credential. A secret API key must never be embedded in the desktop app.

The native layer generates PKCE S256 and a random state, opens an app-owned companion webview, and accepts the `toney://tone3000/callback` deep link only for the current unexpired selection. Codes are single use. The macOS URL scheme is registered through Tauri's deep-link bundle configuration; callbacks are handled directly through the native `RunEvent::Opened` event. The plugin's default runtime emitter is not initialized because it broadcasts callback URLs to webviews. Tokens stay in native process memory for this checkpoint; users reconnect after restarting. Credentials, codes, verifiers, and authenticated download URLs never enter the frontend, diagnostic exports, presets, or the local asset library.

Amp selection restricts gear to `amp`, format to `nam`, and architecture to A1. Cabinet selection restricts gear to `cab` and format to `ir`. Toney's existing engine validation remains authoritative: catalog eligibility does not guarantee that every capture passes the supported file format and architecture checks. Pedal selection uses gear `pedal`, format `nam` and A1, targeting an independent Drive stage. Classic pedal captures now use independent native state before amp/cab; A2 and parametric captures still require separate engine work.

After a user selects a tone, Toney loads only that tone's metadata and a bounded model list. The user chooses a variant and explicitly downloads it. No catalog mirroring, bulk download, or redistributed starter captures are part of this checkpoint.

## Asset boundary

The native client validates the server-provided download URL, bounds response size and time, and passes downloaded bytes through the same helper inspection and content-addressed installation as local imports. NAM is limited to 32 MiB; IR to 8 MiB. Bearer credentials are restricted to the official API origin. The initial file URL must be on the official API origin. After the reported redirect failure, file requests may follow at most three HTTPS redirects delegated by that endpoint. Each delegated hostname is resolved, every returned address must be public, and the validated addresses are pinned for that connection. IP literals, private/reserved networks, credentials in URLs, custom ports and fragments are rejected. Account credentials are never attached to storage requests and are not reattached after delegation, even if a later redirect returns to the API. API JSON requests continue to reject redirects. Redirect locations never enter errors or diagnostics.

Optional source metadata belongs to the durable asset descriptor, alongside inspected metadata. It records provider, tone/model IDs, tone title, creator, license, and source URL. ToneSpec continues to contain only content hash, kind, and a safe display name. Existing local assets and presets remain readable. Reimporting identical bytes preserves credit already associated with those bytes.

Downloads populate the library. Applying a model remains an explicit pedal/amp/cabinet selection after download, so a browser sign-in cannot silently replace a rig edited during that sign-in.

## Verification and traceability

Test strict request correlation and metadata at the TypeScript and Rust boundaries, OAuth state/cancellation/replay handling, trusted delivery URLs, compatibility filtering, bounded downloads, and provenance persistence. Use the actual native helper for asset inspection. Trace operation IDs, timings, model/content IDs, and stable error codes; exclude credentials and signed URLs.

A live acceptance test requires the user to sign in and select a tone. Transport fixtures and headless engine tests do not establish a successful account authorization or production file download. Record live and automated verification separately in the checkpoint log.

## References

- [TONE3000 API and design requirements](https://www.tone3000.com/api)
- [Official reference client](https://github.com/tone-3000/api)
- [TONE3000 API terms](https://www.tone3000.com/api/terms)
- [Tauri deep-link configuration](https://v2.tauri.app/plugin/deep-linking/)

The current scope is personal development. Review commercial terms before a paid launch. Creator licenses and attribution apply to downloaded assets independently of Toney's code license.

## Checkpoint 010 update

The official Select flow now opens in an app-owned companion window with `menubar=true` and `preview=true`. The native callback handler validates/consumes state before closing that generation’s window. Window close cancels only an authorizing session of the same generation. The remote window receives no capabilities; normal HTTPS account navigation stays in that surface, local protocols and direct downloads are denied. Native file import remains the only download path. See Tauri’s [remote capability rules](https://v2.tauri.app/security/capabilities/) and the official [Select documentation](https://www.tone3000.com/api).

Recommendations can initiate an explicit gear selection and display catalog search terms. Hosted Select does not document search prefill; suggested text is entered into its search field by the user. No credential is added to a frontend URL. Independent pedal slots now allow several compatible NAM captures in one rig alongside builtin time-varying effects.
