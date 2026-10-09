- **Owner iMessages come from Rush's number, with no Mac required (PHNX-4267).** rush/api now
  sends owner iMessages itself from Rush's SendBlue number to the phone number you confirm in the
  console Settings page, so the macOS-only `owner-device-delivery` daemon service and its
  `/me/device-deliveries` client are gone. A notification that reaches your account now reads
  "Rush is sending slack, imessage" instead of "delivered ... / queued imessage". A leftover
  `owner-device-delivery` key in `services.yaml` is ignored. `agents send --channel imessage --to
  <number>` still sends from this Mac's Messages app. Source: `cli/src/lib/owner-notify.ts`.
