"""Manifest dataclasses + loader, and the S3 helpers used across the runner.

The manifest is the ONLY input the container reads (env vars point at it); the
runner writes exactly one output (result.json). Everything here is deliberately
tolerant of missing/optional fields so a malformed manifest degrades to a clean
"failed" result rather than an unhandled crash.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Optional

import boto3


# --- S3 access ---------------------------------------------------------------


class S3Store:
    """Thin wrapper over a boto3 S3 client with the few operations we need.

    The task role grants s3:GetObject on media/v1/* and workflows/v1/*, and
    s3:PutObject on workflows/v1/* — so we only ever read MP4s/manifests and
    write result.json / clip JPEGs.
    """

    def __init__(self, region: Optional[str]) -> None:
        self.client = boto3.client("s3", region_name=region)

    def download_json(self, bucket: str, key: str) -> dict[str, Any]:
        obj = self.client.get_object(Bucket=bucket, Key=key)
        return json.loads(obj["Body"].read())

    def upload_json(self, bucket: str, key: str, obj: Any) -> None:
        body = json.dumps(obj, default=str, separators=(",", ":")).encode("utf-8")
        self.client.put_object(
            Bucket=bucket, Key=key, Body=body, ContentType="application/json"
        )

    def download_file(self, bucket: str, key: str, dest: str) -> None:
        self.client.download_file(bucket, key, dest)

    def upload_file(
        self, bucket: str, key: str, src: str, content_type: Optional[str] = None
    ) -> None:
        extra = {"ContentType": content_type} if content_type else None
        self.client.upload_file(src, bucket, key, ExtraArgs=extra)

    def put_bytes(
        self, bucket: str, key: str, data: bytes, content_type: str
    ) -> None:
        self.client.put_object(
            Bucket=bucket, Key=key, Body=data, ContentType=content_type
        )


# --- Manifest model ----------------------------------------------------------


def _s(v: Any) -> Optional[str]:
    """Coerce to a non-empty string or None (treats the literal "null" as None)."""
    if v is None:
        return None
    s = str(v)
    return None if s == "" or s == "null" else s


@dataclass
class NodeDef:
    id: str
    type: str
    label: str
    config: dict[str, Any]
    position: dict[str, float] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "NodeDef":
        data = d.get("data") or {}
        return cls(
            id=str(d.get("id", "")),
            type=str(d.get("type", "")),
            label=str(data.get("label") or d.get("id") or d.get("type") or ""),
            config=dict(data.get("config") or {}),
            position=dict(d.get("position") or {}),
        )


@dataclass
class EdgeDef:
    id: str
    source: str
    target: str

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "EdgeDef":
        return cls(
            id=str(d.get("id", "")),
            source=str(d.get("source", "")),
            target=str(d.get("target", "")),
        )


@dataclass
class Definition:
    nodes: list[NodeDef]
    edges: list[EdgeDef]

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Definition":
        return cls(
            nodes=[NodeDef.from_dict(n) for n in (d.get("nodes") or [])],
            edges=[EdgeDef.from_dict(e) for e in (d.get("edges") or [])],
        )


@dataclass
class InputRef:
    node_id: Optional[str]
    s3_bucket: Optional[str]
    s3_key: Optional[str]
    recording_id: Optional[str]
    recording_started_at: Optional[str]
    capture_started_at: Optional[str]

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "InputRef":
        return cls(
            node_id=_s(d.get("nodeId")),
            s3_bucket=_s(d.get("s3Bucket")),
            s3_key=_s(d.get("s3Key")),
            recording_id=_s(d.get("recordingId")),
            recording_started_at=_s(d.get("recordingStartedAt")),
            capture_started_at=_s(d.get("captureStartedAt")),
        )


@dataclass
class TriggerContext:
    type: Optional[str]
    recording_id: Optional[str]
    stream_key: Optional[str]
    s3_key: Optional[str]
    recording_started_at: Optional[str]
    capture_started_at: Optional[str]

    @classmethod
    def from_dict(cls, d: Optional[dict[str, Any]]) -> "TriggerContext":
        d = d or {}
        return cls(
            type=_s(d.get("type")),
            recording_id=_s(d.get("recordingId")),
            stream_key=_s(d.get("streamKey")),
            s3_key=_s(d.get("s3Key")),
            recording_started_at=_s(d.get("recordingStartedAt")),
            capture_started_at=_s(d.get("captureStartedAt")),
        )


@dataclass
class Output:
    bucket: Optional[str]
    result_key: Optional[str]
    clip_prefix: Optional[str]

    @classmethod
    def from_dict(cls, d: Optional[dict[str, Any]]) -> "Output":
        d = d or {}
        return cls(
            bucket=_s(d.get("bucket")),
            result_key=_s(d.get("resultKey")),
            clip_prefix=_s(d.get("clipPrefix")),
        )


@dataclass
class Limits:
    max_runtime_seconds: int = 1800

    @classmethod
    def from_dict(cls, d: Optional[dict[str, Any]]) -> "Limits":
        d = d or {}
        try:
            secs = int(d.get("maxRuntimeSeconds", 1800))
        except (TypeError, ValueError):
            secs = 1800
        return cls(max_runtime_seconds=max(1, secs))


@dataclass
class Manifest:
    run_id: Optional[str]
    device_id: Optional[str]
    definition: Definition
    trigger_context: TriggerContext
    inputs: list[InputRef]
    output: Output
    limits: Limits

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Manifest":
        return cls(
            run_id=_s(d.get("runId")),
            device_id=_s(d.get("deviceId")),
            definition=Definition.from_dict(d.get("definition") or {}),
            trigger_context=TriggerContext.from_dict(d.get("triggerContext")),
            inputs=[InputRef.from_dict(i) for i in (d.get("inputs") or [])],
            output=Output.from_dict(d.get("output")),
            limits=Limits.from_dict(d.get("limits")),
        )
