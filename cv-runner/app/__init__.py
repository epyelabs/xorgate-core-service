"""Xorgate CV runner package.

A self-contained Python computer-vision runner that executes a workflow graph
over a recorded MP4 inside a Fargate (ARM64) task. It reads a manifest from S3,
runs an object-detection + tracking pipeline, and ALWAYS writes result.json back
to S3. It never touches a database and holds no API credentials — all SQL lives
in the TypeScript services.
"""
