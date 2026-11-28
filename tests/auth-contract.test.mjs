import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hasGlobalPermission,
  parseAuthenticatedUser,
} from "../src/auth/types.ts";
import { SessionOperationCoordinator } from "../src/auth/sessionOperationCoordinator.ts";

const csrfToken = "A".repeat(43);

function profile(overrides = {}) {
  return {
    userId: "user-1",
    status: "ACTIVE",
    displayName: "Steam account",
    steamId: "76561198000000000",
    roles: ["UTILISATEUR"],
    grants: [
      {
        permission: "projects.read",
        scope: "PROJECT",
        projectId: "project-1",
      },
    ],
    csrfToken,
    ...overrides,
  };
}

test("parses backend identity and scoped permission grants", () => {
  const user = parseAuthenticatedUser(profile());
  assert.equal(user.steamId, "76561198000000000");
  assert.equal(user.grants[0]?.scope, "PROJECT");
  assert.equal(hasGlobalPermission(user, "administration.access"), false);
});

test("does not grant administration access from a role label alone", () => {
  const user = parseAuthenticatedUser(
    profile({ roles: ["ADMINISTRATEUR"], grants: [] }),
  );
  assert.equal(hasGlobalPermission(user, "administration.access"), false);

  const authorized = parseAuthenticatedUser(
    profile({
      roles: ["UTILISATEUR"],
      grants: [{ permission: "administration.access", scope: "GLOBAL" }],
    }),
  );
  assert.equal(hasGlobalPermission(authorized, "administration.access"), true);
});

test("rejects malformed or unknown backend permission data", () => {
  assert.throws(
    () => parseAuthenticatedUser(profile({ steamId: "not-a-steamid" })),
    /invalid_profile_response/,
  );
  assert.throws(
    () =>
      parseAuthenticatedUser(
        profile({
          grants: [{ permission: "superuser", scope: "GLOBAL" }],
        }),
      ),
    /invalid_profile_response/,
  );
  assert.throws(
    () => parseAuthenticatedUser(profile({ csrfToken: "short" })),
    /invalid_profile_response/,
  );
});

test("coalesces concurrent refresh operations within one auth generation", async () => {
  const coordinator = new SessionOperationCoordinator();
  let operationCount = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const operation = async () => {
    operationCount += 1;
    await gate;
  };

  const first = coordinator.runRefresh(operation);
  const second = coordinator.runRefresh(operation);
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(operationCount, 1);
  release();
  await Promise.all([first, second]);
});

test("does not apply a refresh response made stale by logout", async () => {
  const coordinator = new SessionOperationCoordinator();
  let releaseStale;
  const staleGate = new Promise((resolve) => {
    releaseStale = resolve;
  });
  const applied = [];
  let staleSignal;

  const staleRefresh = coordinator.runRefresh(async ({ generation, signal }) => {
    staleSignal = signal;
    await staleGate;
    coordinator.runIfCurrent(generation, () => applied.push("stale"));
  });

  await Promise.resolve();
  coordinator.invalidate();
  assert.equal(staleSignal.aborted, true);

  await coordinator.runRefresh(async ({ generation }) => {
    coordinator.runIfCurrent(generation, () => applied.push("current"));
  });
  releaseStale();
  await staleRefresh;

  assert.deepEqual(applied, ["current"]);
});

test("logout fences an old refresh and follows an in-flight desktop exchange", async () => {
  const coordinator = new SessionOperationCoordinator();
  let releaseRefresh;
  let releaseExchange;
  const refreshGate = new Promise((resolve) => {
    releaseRefresh = resolve;
  });
  const exchangeGate = new Promise((resolve) => {
    releaseExchange = resolve;
  });
  const applied = [];
  let sessionCookie = null;
  const oldGeneration = coordinator.generation;

  const refresh = coordinator.runRefresh(async ({ generation }) => {
    await refreshGate;
    coordinator.runIfCurrent(generation, () => applied.push("old profile"));
  });
  const exchange = coordinator.runSessionMutation(async () => {
    await exchangeGate;
    sessionCookie = "new session";
  });

  await Promise.resolve();
  coordinator.invalidate();
  const logout = coordinator.runSessionMutation(async () => {
    sessionCookie = null;
  });

  releaseExchange();
  await Promise.all([exchange, logout]);
  releaseRefresh();
  await refresh;

  coordinator.runIfCurrent(oldGeneration, () => applied.push("late profile"));
  assert.equal(sessionCookie, null);
  assert.deepEqual(applied, []);
});

test("skips a refresh invalidated before its request starts", async () => {
  const coordinator = new SessionOperationCoordinator();
  let operationCount = 0;
  const refresh = coordinator.runRefresh(async () => {
    operationCount += 1;
  });

  coordinator.invalidate();
  await refresh;
  assert.equal(operationCount, 0);
});

test("serializes desktop exchange and logout mutations after failures", async () => {
  const coordinator = new SessionOperationCoordinator();
  const order = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const first = coordinator.runSessionMutation(async () => {
    order.push("exchange-started");
    await firstGate;
    throw new Error("first failed");
  });
  const second = coordinator.runSessionMutation(async () => {
    order.push("logout-started");
  });

  await Promise.resolve();
  assert.deepEqual(order, ["exchange-started"]);
  releaseFirst();
  await assert.rejects(first, /first failed/);
  await second;
  assert.deepEqual(order, ["exchange-started", "logout-started"]);
});

test("orders credential cleanup before a newer pending login is stored", async () => {
  const coordinator = new SessionOperationCoordinator();
  const order = [];
  let credential = "old";
  let releaseClear;
  const clearGate = new Promise((resolve) => {
    releaseClear = resolve;
  });

  const clear = coordinator.runCredentialOperation(async () => {
    order.push("clear-started");
    await clearGate;
    credential = null;
    order.push("clear-finished");
  });
  const store = coordinator.runCredentialOperation(async () => {
    order.push("store-new-login");
    credential = "new";
  });

  await Promise.resolve();
  assert.deepEqual(order, ["clear-started"]);
  releaseClear();
  await Promise.all([clear, store]);

  assert.deepEqual(order, [
    "clear-started",
    "clear-finished",
    "store-new-login",
  ]);
  assert.equal(credential, "new");
});
