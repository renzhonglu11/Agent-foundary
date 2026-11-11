"""Stop asking a source that has turned this client away.

HTTP 403 and 429 answer the client, not the product that was asked for.
Repeating the request for every remaining product is what turns a temporary
limit into a lasting block, so the first refusal ends the source's part in
the run.
"""

from __future__ import annotations

import logging

import httpx

logger = logging.getLogger(__name__)

REFUSAL_STATUS_CODES = frozenset({403, 429})


class SourceGuard:
    def __init__(self, source: str) -> None:
        self.source = source
        self.refused = False

    def check(self, response: httpx.Response) -> None:
        if response.status_code in REFUSAL_STATUS_CODES and not self.refused:
            self.refused = True
            logger.warning(
                "%s refused the request with HTTP %d; not asking it again in this run",
                self.source,
                response.status_code,
            )
