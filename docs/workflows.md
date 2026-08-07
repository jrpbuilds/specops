# Interactive workflow

SpecOps follows upstream `spec-driven`: explore → proposal → specs → design → tasks → planning checkpoint → implement → required validation → independent review → bounded repair → completion checkpoint → archive.

Planning and completion are the two normal checkpoints. A dirty tree is captured as a baseline and never reset. Validation and review are bound to deterministic repository identities; external mutation invalidates stale evidence. “Leave change open” creates a verified-but-unarchived state. Archive requires explicit approval and failed archive retry occurs through `/specops`.
