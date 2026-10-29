# Validation — 2026-10-28

Runtime tested: macOS Intel, local Choibox 1.13.0 preview with a separate data directory.

Observed with an account entered directly by the user:
- Native Facebook sign-in completed.
- Messenger encrypted connection became ready.
- Exact incoming test marker TEST CHOIBOX RIENG was stored in an encrypted conversation.
- A user-authorized reply in that same test conversation returned a Messenger message ID.
- Pausing the channel closed its worker. Re-enabling created another worker, restored
  the saved cookie/device store and reached encrypted connected state without a password.

A server acknowledgment is not proof that a person read a message.
No account IDs, names, cookies, OTPs or message payloads other than generic test markers
are included in this report.

Automated validation:
- Node regression suite: 78 tests passed (existing functionality plus five new Facebook tests).
- Go connector tests: 2 tests passed.
- go mod verify: all modules verified.
- UI exercised through sign-in, selecting Facebook personal, incoming test and reply,
  pause/re-enable. Tested narrow browser viewport and responsive navigation.

Windows AMD64, macOS ARM64 and Linux AMD64 binaries were cross-compiled successfully; compilation is
not a substitute for runtime testing on those systems. Full message history, media
sending/decoding and Page/comment support are outside this connector's verified scope.

The connector links pinned upstream libraries; it does not run Deplao application
code or Deplao's prebuilt executables. These checks are not a complete malware audit.

## 1.13.1 release validation

- Node regression suite: 83 passed; Go boundary/media suite: 6 passed.
- New worker restored the same test account; UI showed connected when both transports
  were ready, paused immediately on pause and connecting while restoring.
- Inline image loaded at 320×180; enlarged image viewer opened. A synthetic H.264 MP4
  loaded with duration 2 seconds and playback advanced with paused=false, no decoder error.
- Encrypted media descriptor storage, authorization, chunk size/token bounds, Range playback
  and deletion tombstones passed automated tests.
- Live Facebook image/video transfer is awaiting a fresh user-sent test file;
  synthetic playback does not establish a live encrypted media transfer.
- Personal Facebook outgoing media and Page/comments remain unsupported by this connector.

Release verification after packaging: live encrypted JPEG opened at 1280×720; live MP4 decoded and played at 854×960, duration 14.125s. No private payloads or identities are included.
