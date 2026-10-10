import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";
import { seedIncident } from "../src/seed.ts";

describe("regressões do incidente", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    const db = openDatabase(":memory:");
    seedIncident(db);
    app = createApp(db);
  });

  function postJson(path: string, body: unknown) {
    return app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it.each([
    ["2026-03-13T02:59:59.999Z", 201],
    ["2026-03-12T23:59:59.999-03:00", 201],
    ["2026-03-13T03:00:00.000Z", 409],
  ])("respeita o limite do prazo em %s", async (approvedAt, status) => {
    const res = await postJson("/approvals", {
      mission_id: "msn_1842",
      approved_at: approvedAt,
      idempotency_key: "pay_boundary",
    });
    expect(res.status).toBe(status);
  });

  it("reutiliza o crédito quando o retry contém U+200B na chave", async () => {
    const payload = {
      mission_id: "msn_2044",
      approved_at: "2026-03-12T21:05:00.000Z",
      idempotency_key: "pay_7c1",
    };
    const first = await postJson("/approvals", payload);
    expect(first.status).toBe(201);
    const original = await first.json();

    const retry = await postJson("/approvals", {
      ...payload,
      idempotency_key: "pay_7c1\u200B",
    });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(original);

    const res = await app.request("/missions/msn_2044");
    const body = await res.json();
    expect(body.ledger).toHaveLength(1);
    expect(body.ledger[0].amount_brl).toBe(80);
    expect(body.ledger[0].idempotency_key).toBe("pay_7c1");
  });

  it("marca como pago quando o provedor retorna CONFIRMED", async () => {
    const approval = await postJson("/approvals", {
      mission_id: "msn_2044",
      approved_at: "2026-03-12T21:05:00.000Z",
      idempotency_key: "pay_confirmed",
    });
    const { payout } = await approval.json();
    const res = await postJson(`/payouts/${payout.id}/provider`, {
      provider_status: "CONFIRMED",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      provider_status: "CONFIRMED",
      status: "paid",
    });

    const mission = await app.request("/missions/msn_2044");
    expect((await mission.json()).payout.status).toBe("paid");
  });
});
