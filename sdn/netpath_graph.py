"""Topology graph helpers shared by the POX controller and the tests.

Kept free of POX imports so the path logic can be unit-tested anywhere.
Switches are identified by datapath id (int); a path is a list of dpids.
"""

MAX_PATHS = 16
MAX_LENGTH = 8


def neighbours(links):
    """{dpid: {neighbour dpid: local port}} from links {(a, a_port, b, b_port), ...}."""
    adj = {}
    for a, a_port, b, b_port in links:
        adj.setdefault(a, {})[b] = a_port
        adj.setdefault(b, {})[a] = b_port
    return adj


def candidate_paths(links, src, dst, limit=MAX_PATHS):
    """Every loop-free switch path from src to dst (shortest first, then by switch ids)."""
    if src == dst:
        return [[src]]
    adj = neighbours(links)
    found = []

    def walk(node, path):
        if len(found) >= limit * 4 or len(path) > MAX_LENGTH:
            return
        for nxt in sorted(adj.get(node, {})):
            if nxt in path:
                continue
            if nxt == dst:
                found.append(path + [nxt])
            else:
                walk(nxt, path + [nxt])

    walk(src, [src])
    found.sort(key=lambda p: (len(p), sorted(p)))
    return found[:limit]


def parse_policy(text):
    """Route policy from the policy file: 'auto', 'via N' or 'path A B C'."""
    words = (text or "").split()
    if len(words) >= 2 and words[0] == "via" and words[1].isdigit():
        return ("via", int(words[1]))
    if len(words) >= 3 and words[0] == "path" and all(w.isdigit() for w in words[1:]):
        return ("path", [int(w) for w in words[1:]])
    return ("auto", None)


def choose_path(candidates, policy):
    """Pick the path the policy asks for; fall back to the shortest one.

    The ordering in candidate_paths is symmetric (it sorts by the set of switches),
    so both directions of a conversation take the same switches.
    """
    if not candidates:
        return None
    kind, arg = policy
    if kind == "via":
        for p in candidates:
            if arg in p:
                return p
    elif kind == "path":
        for p in candidates:
            if p == arg or p == list(reversed(arg)):
                return p
    return candidates[0]


def ports_along(links, path, last_port):
    """[(dpid, out_port)] for each switch on the path; the last one outputs to last_port."""
    adj = neighbours(links)
    hops = []
    for i, dpid in enumerate(path):
        out = adj[dpid][path[i + 1]] if i + 1 < len(path) else last_port
        hops.append((dpid, out))
    return hops


def uses_link(path, a, b):
    """True if the path crosses the link between switches a and b (either direction)."""
    return any({x, y} == {a, b} for x, y in zip(path, path[1:]))
