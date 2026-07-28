from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "sync-opencode-manifest.py"
SPEC = importlib.util.spec_from_file_location("sync_opencode_manifest", SCRIPT)
assert SPEC and SPEC.loader
sync = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sync)


class SyncManifestTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        (self.root / ".opencode").mkdir()

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def write_manifest(self, agents: dict[str, object]) -> None:
        (self.root / ".opencode" / "sdd-manifest.json").write_text(
            json.dumps({"agents": agents}), encoding="utf-8"
        )

    def test_supports_short_and_object_formats(self) -> None:
        self.write_manifest(
            {
                "short-agent": "provider/short",
                "object-agent": {
                    "model": "provider/object",
                    "thinking": {"type": "enabled", "budgetTokens": 4096},
                    "temperature": 0.1,
                },
            }
        )

        config, prompts = sync.desired_state(self.root)

        self.assertEqual(config["agent"]["short-agent"]["model"], "provider/short")
        self.assertEqual(config["agent"]["short-agent"]["mode"], "subagent")
        self.assertEqual(
            config["agent"]["object-agent"]["thinking"]["budgetTokens"], 4096
        )
        self.assertEqual(config["agent"]["object-agent"]["temperature"], 0.1)
        self.assertEqual(set(prompts), {"short-agent", "object-agent"})

    def test_preserves_unrelated_config_and_agents(self) -> None:
        self.write_manifest({"managed": "provider/model"})
        (self.root / "opencode.json").write_text(
            json.dumps(
                {
                    "theme": "system",
                    "mcp": {"example": {"type": "local"}},
                    "agent": {"user-agent": {"model": "user/model"}},
                }
            ),
            encoding="utf-8",
        )

        config, _ = sync.desired_state(self.root)

        self.assertEqual(config["theme"], "system")
        self.assertIn("example", config["mcp"])
        self.assertEqual(config["agent"]["user-agent"]["model"], "user/model")
        self.assertEqual(config["agent"]["managed"]["model"], "provider/model")

    def test_existing_prompt_is_never_overwritten(self) -> None:
        self.write_manifest({"managed": "provider/model"})
        prompt_dir = self.root / ".opencode" / "prompts"
        prompt_dir.mkdir()
        prompt = prompt_dir / "managed.md"
        prompt.write_text("# User prompt\n", encoding="utf-8")

        _, prompts = sync.desired_state(self.root)

        self.assertEqual(prompts, {})
        self.assertEqual(prompt.read_text(encoding="utf-8"), "# User prompt\n")

    def test_assessor_stub_preserves_structured_routing_contract(self) -> None:
        self.write_manifest({"sdd-assess": "provider/model"})

        _, prompts = sync.desired_state(self.root)

        self.assertIn("suggested_tier", prompts["sdd-assess"])
        self.assertIn("critical_unknowns", prompts["sdd-assess"])
        self.assertIn("Return only JSON", prompts["sdd-assess"])

    def test_generated_worker_stub_uses_strict_escalation_contract(self) -> None:
        self.write_manifest({"sdd-explore": "provider/model"})

        _, prompts = sync.desired_state(self.root)

        prompt = prompts["sdd-explore"]
        self.assertIn("Escalation is exceptional", prompt)
        self.assertIn("small reversible assumption", prompt)
        self.assertIn("own final line", prompt)

    def test_rejects_unsafe_agent_id(self) -> None:
        self.write_manifest({"../escape": "provider/model"})

        with self.assertRaises(SystemExit):
            sync.desired_state(self.root)


if __name__ == "__main__":
    unittest.main()
