export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    const url = new URL(request.url);

    // GET /crew?email=<you> — the roster. Returns display names only, never full
    // email addresses; the caller's own row is flagged so the UI can highlight it.
    if (url.pathname === "/crew") {
      if (request.method !== "GET") {
        return new Response("Method not allowed", { status: 405, headers: cors });
      }
      const me = (url.searchParams.get("email") || "").trim().toLowerCase();
      const listed = await env.ODYSSEY_KV.list({ prefix: "user:", limit: 200 });
      const crew = [];
      for (const k of listed.keys) {
        const raw = await env.ODYSSEY_KV.get(k.name);
        if (!raw) continue;
        let d;
        try {
          d = JSON.parse(raw);
        } catch (e) {
          continue;
        }
        if (!d || typeof d !== "object") continue;
        const addr = k.name.slice(5);
        const studied = Array.isArray(d.studied) ? d.studied : [];
        crew.push({
          name: addr.split("@")[0],
          xp: d.xp || 0,
          cleared: d.cleared ? Object.keys(d.cleared).length : 0,
          lastStudied: studied.length ? studied.slice().sort().pop() : null,
          you: !!me && addr === me,
        });
      }
      crew.sort((a, b) => b.xp - a.xp || b.cleared - a.cleared);
      return new Response(JSON.stringify(crew), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    if (url.pathname !== "/progress") {
      return new Response("Not found", { status: 404, headers: cors });
    }

    const email = (url.searchParams.get("email") || "").trim().toLowerCase();
    if (!email || !email.includes("@") || email.length > 200) {
      return new Response(JSON.stringify({ error: "Valid email required" }), {
        status: 400,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    const key = "user:" + email;

    if (request.method === "GET") {
      const data = await env.ODYSSEY_KV.get(key);
      return new Response(data === null ? "null" : data, {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    if (request.method === "POST") {
      const body = await request.text();
      if (body.length > 200000) {
        return new Response(JSON.stringify({ error: "Payload too large" }), {
          status: 413,
          headers: { ...cors, "Content-Type": "application/json" },
        });
      }
      try {
        JSON.parse(body);
      } catch (e) {
        return new Response(JSON.stringify({ error: "Body must be valid JSON" }), {
          status: 400,
          headers: { ...cors, "Content-Type": "application/json" },
        });
      }
      await env.ODYSSEY_KV.put(key, body);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    return new Response("Method not allowed", { status: 405, headers: cors });
  },
};
