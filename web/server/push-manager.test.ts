import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tempDir: string;
let pushManager: typeof import("./push-manager.js");

const mockHomedir = vi.hoisted(() => {
  let dir = "";
  return {
    get: () => dir,
    set: (d: string) => {
      dir = d;
    },
  };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => mockHomedir.get(),
  };
});

// Mock web-push to avoid actual HTTP calls
const mockSendNotification = vi.fn();
const mockGenerateVAPIDKeys = vi.fn(() => ({
  publicKey: "BTestPublicKey123456789012345678901234567890123456789012345678901234567890123456",
  privateKey: "TestPrivateKey12345678901234567890",
}));
const mockSetVapidDetails = vi.fn();

vi.mock("web-push", () => ({
  default: {
    generateVAPIDKeys: mockGenerateVAPIDKeys,
    setVapidDetails: mockSetVapidDetails,
    sendNotification: mockSendNotification,
  },
}));

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "push-test-"));
  mockHomedir.set(tempDir);
  mockSendNotification.mockReset();
  mockGenerateVAPIDKeys.mockClear();
  mockSetVapidDetails.mockClear();
  vi.resetModules();
  pushManager = await import("./push-manager.js");
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function companionDir(): string {
  return join(tempDir, ".companion");
}

// ── VAPID Key Management ─────────────────────────────────────────────────────

describe("VAPID key management", () => {
  test("generates and persists VAPID keys on first call", () => {
    const publicKey = pushManager.getVapidPublicKey();

    expect(publicKey).toBeTruthy();
    expect(mockGenerateVAPIDKeys).toHaveBeenCalledOnce();

    // Keys should be persisted to disk
    const keysPath = join(companionDir(), "vapid-keys.json");
    expect(existsSync(keysPath)).toBe(true);

    const saved = JSON.parse(readFileSync(keysPath, "utf-8"));
    expect(saved.publicKey).toBe(publicKey);
    expect(saved.privateKey).toBeTruthy();
  });

  test("reuses existing VAPID keys on subsequent calls", () => {
    const key1 = pushManager.getVapidPublicKey();
    const key2 = pushManager.getVapidPublicKey();

    expect(key1).toBe(key2);
    // Only generated once
    expect(mockGenerateVAPIDKeys).toHaveBeenCalledOnce();
  });
});

// ── Subscription CRUD ────────────────────────────────────────────────────────

describe("subscription CRUD", () => {
  const sub1 = {
    endpoint: "https://push.example.com/sub1",
    keys: { p256dh: "key1-p256dh", auth: "key1-auth" },
  };

  const sub2 = {
    endpoint: "https://push.example.com/sub2",
    keys: { p256dh: "key2-p256dh", auth: "key2-auth" },
  };

  test("addSubscription stores a subscription", () => {
    pushManager.addSubscription(sub1);
    const all = pushManager.getAllSubscriptions();
    expect(all).toHaveLength(1);
    expect(all[0].endpoint).toBe(sub1.endpoint);
  });

  test("addSubscription deduplicates by endpoint", () => {
    pushManager.addSubscription(sub1);
    // Update keys for same endpoint
    pushManager.addSubscription({
      endpoint: sub1.endpoint,
      keys: { p256dh: "updated", auth: "updated" },
    });

    const all = pushManager.getAllSubscriptions();
    expect(all).toHaveLength(1);
    expect(all[0].keys.p256dh).toBe("updated");
  });

  test("addSubscription supports multiple subscriptions", () => {
    pushManager.addSubscription(sub1);
    pushManager.addSubscription(sub2);

    const all = pushManager.getAllSubscriptions();
    expect(all).toHaveLength(2);
  });

  test("removeSubscription removes by endpoint", () => {
    pushManager.addSubscription(sub1);
    pushManager.addSubscription(sub2);

    const removed = pushManager.removeSubscription(sub1.endpoint);
    expect(removed).toBe(true);

    const all = pushManager.getAllSubscriptions();
    expect(all).toHaveLength(1);
    expect(all[0].endpoint).toBe(sub2.endpoint);
  });

  test("removeSubscription returns false for unknown endpoint", () => {
    const removed = pushManager.removeSubscription("https://unknown.example.com");
    expect(removed).toBe(false);
  });

  test("subscriptions persist to disk", () => {
    pushManager.addSubscription(sub1);

    const subsPath = join(companionDir(), "push-subscriptions.json");
    expect(existsSync(subsPath)).toBe(true);

    const saved = JSON.parse(readFileSync(subsPath, "utf-8"));
    expect(saved).toHaveLength(1);
    expect(saved[0].endpoint).toBe(sub1.endpoint);
  });
});

// ── Push Sending ─────────────────────────────────────────────────────────────

describe("sendPushToAll", () => {
  const sub = {
    endpoint: "https://push.example.com/sub",
    keys: { p256dh: "key-p256dh", auth: "key-auth" },
  };

  test("sends notification to all subscriptions", async () => {
    mockSendNotification.mockResolvedValue({});
    pushManager.addSubscription(sub);

    await pushManager.sendPushToAll({
      title: "Test",
      body: "Hello",
      data: { sessionId: "session-123", type: "result" },
    });

    expect(mockSendNotification).toHaveBeenCalledOnce();
    const [sentSub, sentBody] = mockSendNotification.mock.calls[0];
    expect(sentSub.endpoint).toBe(sub.endpoint);
    const payload = JSON.parse(sentBody);
    expect(payload.title).toBe("Test");
    expect(payload.body).toBe("Hello");
    expect(payload.data.sessionId).toBe("session-123");
  });

  test("does nothing when no subscriptions exist", async () => {
    await pushManager.sendPushToAll({ title: "Test", body: "Hello" });
    expect(mockSendNotification).not.toHaveBeenCalled();
  });

  test("removes expired subscriptions on 410 response", async () => {
    // Add two subscriptions
    pushManager.addSubscription(sub);
    pushManager.addSubscription({
      endpoint: "https://push.example.com/expired",
      keys: { p256dh: "k", auth: "k" },
    });

    // First call succeeds, second returns 410 Gone
    mockSendNotification
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce({ statusCode: 410 });

    await pushManager.sendPushToAll({ title: "Test", body: "Hello" });

    // Expired subscription should have been cleaned up
    const remaining = pushManager.getAllSubscriptions();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].endpoint).toBe(sub.endpoint);
  });

  test("removes expired subscriptions on 404 response", async () => {
    pushManager.addSubscription(sub);

    mockSendNotification.mockRejectedValueOnce({ statusCode: 404 });

    await pushManager.sendPushToAll({ title: "Test", body: "Hello" });

    const remaining = pushManager.getAllSubscriptions();
    expect(remaining).toHaveLength(0);
  });

  test("keeps subscription on transient errors", async () => {
    pushManager.addSubscription(sub);

    mockSendNotification.mockRejectedValueOnce({ statusCode: 500 });

    await pushManager.sendPushToAll({ title: "Test", body: "Hello" });

    // Subscription should still be there
    const remaining = pushManager.getAllSubscriptions();
    expect(remaining).toHaveLength(1);
  });
});
