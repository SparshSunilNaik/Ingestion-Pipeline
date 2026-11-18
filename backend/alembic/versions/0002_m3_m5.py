"""M3-M5: per-file analysis cache, Q&A conversations, API sessions; snapshot identity includes analyzer version.

Backward compatible: existing rows are kept unchanged. The unique constraint on snapshots widens from
(repository_id, commit_sha) to (repository_id, commit_sha, analyzer_version) so a newer analyzer can
produce a new snapshot of the same commit without overwriting the previous valid analysis.

Revision ID: 0002
Revises: 0001
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("snapshots") as batch:
        batch.drop_constraint("uq_snapshot_commit", type_="unique")
        batch.create_unique_constraint("uq_snapshot_commit_version", ["repository_id", "commit_sha", "analyzer_version"])

    op.create_table(
        "file_analyses",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("snapshot_id", sa.Integer(), sa.ForeignKey("snapshots.id", ondelete="CASCADE"), nullable=False),
        sa.Column("path", sa.String(1000), nullable=False),
        sa.Column("sha256", sa.String(64), nullable=False),
        sa.Column("analyzer_version", sa.String(32), nullable=False),
        sa.Column("language", sa.String(32), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.UniqueConstraint("snapshot_id", "path", name="uq_file_analysis_path"),
    )
    op.create_index("ix_file_analyses_snapshot_id", "file_analyses", ["snapshot_id"])
    op.create_index("ix_file_analyses_sha", "file_analyses", ["sha256", "analyzer_version"])

    op.create_table(
        "conversations",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("snapshot_id", sa.Integer(), sa.ForeignKey("snapshots.id", ondelete="CASCADE"), nullable=False),
        sa.Column("title", sa.String(300), nullable=False),
        sa.Column("model", sa.String(200), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_conversations_snapshot_id", "conversations", ["snapshot_id"])

    op.create_table(
        "messages",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("conversation_id", sa.Integer(), sa.ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("role", sa.String(16), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("job_id", sa.Integer(), sa.ForeignKey("jobs.id", ondelete="SET NULL"), nullable=True),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_messages_conversation_id", "messages", ["conversation_id"])

    op.create_table(
        "api_sessions",
        sa.Column("id_hash", sa.String(64), primary_key=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("api_sessions")
    op.drop_index("ix_messages_conversation_id", "messages")
    op.drop_table("messages")
    op.drop_index("ix_conversations_snapshot_id", "conversations")
    op.drop_table("conversations")
    op.drop_index("ix_file_analyses_sha", "file_analyses")
    op.drop_index("ix_file_analyses_snapshot_id", "file_analyses")
    op.drop_table("file_analyses")
    with op.batch_alter_table("snapshots") as batch:
        batch.drop_constraint("uq_snapshot_commit_version", type_="unique")
        batch.create_unique_constraint("uq_snapshot_commit", ["repository_id", "commit_sha"])
