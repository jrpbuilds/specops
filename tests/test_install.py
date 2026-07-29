from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "install.sh"
PLUGIN = "@jrpbuilds/specops"


class InstallScriptTests(unittest.TestCase):
    def run_installer(self, home: Path, server: Path, tui: Path) -> None:
        environment = {
            **os.environ,
            "HOME": str(home),
            "OPENCODE_CONFIG": str(server),
            "OPENCODE_TUI_CONFIG": str(tui),
        }
        subprocess.run(["bash", str(SCRIPT)], check=True, env=environment, capture_output=True, text=True)

    def test_registers_server_and_legacy_tui_plugins_idempotently(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            server = root / "opencode.json"
            tui = root / "tui.json"
            server.write_text(json.dumps({"plugin": ["other"], "share": "disabled"}), encoding="utf-8")
            tui.write_text(json.dumps({"plugins": ["other-tui"], "animations": True}), encoding="utf-8")

            self.run_installer(root, server, tui)
            self.run_installer(root, server, tui)

            self.assertEqual(json.loads(server.read_text(encoding="utf-8"))["plugin"], ["other", PLUGIN])
            self.assertEqual(json.loads(tui.read_text(encoding="utf-8"))["plugins"], ["other-tui", PLUGIN])

    def test_preserves_current_singular_tui_plugin_key(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            server = root / "opencode.json"
            tui = root / "tui.json"
            tui.write_text(json.dumps({"plugin": ["other-tui"]}), encoding="utf-8")

            self.run_installer(root, server, tui)

            config = json.loads(tui.read_text(encoding="utf-8"))
            self.assertEqual(config["plugin"], ["other-tui", PLUGIN])
            self.assertNotIn("plugins", config)


if __name__ == "__main__":
    unittest.main()
