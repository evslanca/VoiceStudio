import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mcp_server import create_mcp_server


def test_mcp_exposes_music_and_workspace_tools():
    server = create_mcp_server()
    assert server.name == "EliVoice"

    tool_names = {tool.name for tool in server._tool_manager.list_tools()}
    for expected in (
        "generate_speech",
        "clone_voice",
        "transcribe",
        "list_voices",
        "music_status",
        "start_music_studio",
        "stop_music_studio",
        "generate_music",
        "get_music_task",
        "list_music_tracks",
        "separate_music_stems",
        "format_music_lyrics",
        "remaster_music",
        "analyze_music",
        "list_projects",
        "list_batch_jobs",
    ):
        assert expected in tool_names, f"Missing MCP tool: {expected}"

    resource_uris = {str(res.uri) for res in server._resource_manager.list_resources()}
    assert "history://recent" in resource_uris
    assert "music://library" in resource_uris
    assert "projects://all" in resource_uris
