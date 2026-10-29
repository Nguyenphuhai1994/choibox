# Choibox Facebook personal connector

The process adapter and Choibox integration are newly written for Choibox.
Protocol implementation: mautrix/meta (AGPL-3.0-or-later), upstream commit
baffb16564deabf691271bcb65168d08f1d49470, fetched directly from
https://github.com/mautrix/meta and pinned in go.mod/go.sum.
Cryptographic protocol: whatsmeow and its dependencies, with their own notices.

This adapter does not load Deplao application code, fbchat-v2 wrappers, or their prebuilt binaries.
It uses the public upstream Messenger client API. Do not remove upstream copyright/license notices.
Dependency source and checksum manifests are available through go.mod/go.sum.
