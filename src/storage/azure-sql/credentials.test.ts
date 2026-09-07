import { describe, expect, it } from "vitest";
import {
  createAzureSqlDeviceCodeCredential,
  createAzureSqlSecretCredential,
} from "./credentials.js";

describe("Azure SQL credentials", () => {
  it("constructs the Linux-compatible device-code credential without starting authentication", () => {
    expect(createAzureSqlDeviceCodeCredential()).toBeDefined();
  });

  it("resolves a fresh token without exposing it in the credential result metadata", async () => {
    const ref = { source: "env" as const, provider: "test", id: "AZURE_SQL_TOKEN" };
    let calls = 0;
    const credential = createAzureSqlSecretCredential(ref, async (received) => {
      expect(received).toEqual(ref);
      calls += 1;
      return "token-fixture-value";
    });

    const first = await credential.getToken("https://database.windows.net/.default");
    const second = await credential.getToken("https://database.windows.net/.default");

    expect(first?.token).toBe("token-fixture-value");
    expect(second?.token).toBe("token-fixture-value");
    expect(calls).toBe(2);
  });

  it("rejects an empty resolved token", async () => {
    const credential = createAzureSqlSecretCredential(
      { source: "env", provider: "test", id: "AZURE_SQL_TOKEN" },
      async () => "  ",
    );

    await expect(credential.getToken("https://database.windows.net/.default")).rejects.toThrow(
      "empty token",
    );
  });
});
