"""Voice chat state management."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


@dataclass
class VoiceParticipant:
    sid: str
    label: str


class VoiceState:
    """Manages voice chat participants in the shared room."""

    def __init__(self):
        """Initialize the in-memory participant registry."""
        self._participants: dict[str, VoiceParticipant] = {}

    def add_participant(self, sid: str, label: str) -> VoiceParticipant:
        """Add a participant to voice chat."""
        participant = VoiceParticipant(sid=sid, label=label)
        self._participants[sid] = participant
        return participant

    def remove_participant(self, sid: str) -> Optional[VoiceParticipant]:
        """Remove a participant from voice chat."""
        return self._participants.pop(sid, None)

    def get_participant(self, sid: str) -> Optional[VoiceParticipant]:
        """Get a participant by SID."""
        return self._participants.get(sid)

    def get_all_participants(self) -> list[VoiceParticipant]:
        """Get all current participants."""
        return list(self._participants.values())

    def is_in_voice(self, sid: str) -> bool:
        """Check if a user is in voice chat."""
        return sid in self._participants

    def clear(self):
        """Clear all participants."""
        self._participants.clear()


voice_state = VoiceState()
