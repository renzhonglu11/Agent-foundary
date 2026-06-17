from yoyo import step


def _columns(conn, table_name):
    cursor = conn.cursor()
    cursor.execute(f"PRAGMA table_info({table_name})")
    return {row[1] for row in cursor.fetchall()}


def apply_step(conn):
    columns = _columns(conn, "instrument_metadata")
    cursor = conn.cursor()
    if "option_type" not in columns:
        cursor.execute("ALTER TABLE instrument_metadata ADD COLUMN option_type TEXT")
    if "reset_barrier" not in columns:
        cursor.execute("ALTER TABLE instrument_metadata ADD COLUMN reset_barrier REAL")


steps = [
    step(apply_step),
]
