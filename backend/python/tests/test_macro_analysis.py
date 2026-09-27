import json
import subprocess

from agent_foundry_python import macro_analysis


def test_run_hermes_analysis_uses_configured_model(monkeypatch):
    monkeypatch.setattr(macro_analysis, "HERMES_PATH", "/path/to/hermes")
    monkeypatch.setattr(macro_analysis, "HERMES_MODEL", "gpt-6-luna")
    calls = []

    def fake_run(cmd, **kwargs):
        calls.append((cmd, kwargs))
        return subprocess.CompletedProcess(
            cmd,
            0,
            stdout=json.dumps({"summary_commentary": "OK", "sectors": []}),
            stderr="",
        )

    monkeypatch.setattr(macro_analysis.subprocess, "run", fake_run)

    result = macro_analysis.run_hermes_analysis({})

    assert result == {"summary_commentary": "OK", "sectors": []}
    assert calls[0][0][0:4] == ["/path/to/hermes", "-m", "gpt-6-luna", "-z"]
    assert calls[0][1]["capture_output"] is True
    assert calls[0][1]["text"] is True
    assert calls[0][1]["check"] is True
    assert calls[0][1]["env"]["HERMES_REASONING_EFFORT"] == "high"
