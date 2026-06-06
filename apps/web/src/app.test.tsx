import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { DroidWebscrApp } from "./app.js";
import { createMemoryStorage } from "./lib/memory-storage.js";

describe("DroidWebscrApp", () => {
  it("renders empty device state and required operational regions", async () => {
    render(
      <DroidWebscrApp
        client={{
          createSession: async () => ({ sessionId: "s1", serial: "emulator-5554", token: "t1" }),
          listDevices: async () => [],
        }}
        storage={createMemoryStorage()}
      />,
    );

    expect(await screen.findByText("No Android devices detected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Scan adb devices" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect by endpoint" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
    expect(screen.getByLabelText("Android screen viewport")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Home" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Overview" })).toBeInTheDocument();
    expect(screen.getByText("Bind 127.0.0.1")).toBeInTheDocument();
  });

  it("shows scanning state and refresh errors from the agent", async () => {
    const user = userEvent.setup();
    let resolveDevices: ((devices: []) => void) | undefined;
    const client = {
      createSession: async () => ({ sessionId: "s1", serial: "emulator-5554", token: "t1" }),
      listDevices: () =>
        new Promise<[]>((resolve) => {
          resolveDevices = resolve;
        }),
    };
    render(<DroidWebscrApp client={client} storage={createMemoryStorage()} />);

    expect(await screen.findByText("Scanning devices")).toBeInTheDocument();
    resolveDevices?.([]);
    expect(await screen.findByText("No Android devices detected")).toBeInTheDocument();

    const failingClient = {
      ...client,
      listDevices: async () => {
        throw new Error("adb unavailable");
      },
    };
    cleanup();
    render(<DroidWebscrApp client={failingClient} storage={createMemoryStorage()} />);
    await user.click(await screen.findByRole("button", { name: "Scan adb devices" }));

    expect(await screen.findAllByText("adb unavailable")).toHaveLength(2);
  });

  it("uses fallback messages for non-Error failures", async () => {
    const user = userEvent.setup();
    render(
      <DroidWebscrApp
        client={{
          createSession: async () => {
            throw "closed";
          },
          listDevices: async () => {
            throw "offline";
          },
        }}
        storage={createMemoryStorage()}
      />,
    );

    expect(await screen.findByText("Device listing failed")).toBeInTheDocument();
    cleanup();

    render(
      <DroidWebscrApp
        client={{
          createSession: async () => {
            throw "closed";
          },
          listDevices: async () => [{ authorizationState: "authorized", serial: "emulator-5554" }],
        }}
        storage={createMemoryStorage()}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "Android device emulator-5554" }));
    await user.click(screen.getByRole("button", { name: "Start" }));

    expect(await screen.findByText("Session creation failed")).toBeInTheDocument();
  });

  it("starts and stops a selected device session", async () => {
    const user = userEvent.setup();
    render(
      <DroidWebscrApp
        client={{
          createSession: async () => ({
            sessionId: "s-emulator",
            serial: "emulator-5554",
            token: "token-emulator",
          }),
          listDevices: async () => [
            {
              authorizationState: "authorized",
              model: "Pixel 8",
              serial: "emulator-5554",
              transportKind: "emulator",
            },
          ],
        }}
        storage={createMemoryStorage()}
      />,
    );

    const device = await screen.findByRole("button", { name: /Pixel 8 emulator-5554/ });
    await user.click(device);
    await user.click(screen.getByRole("button", { name: "Start" }));

    expect(await screen.findByText("Session s-emulator")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Stop" }));

    expect(screen.getByRole("button", { name: "Start" })).toBeEnabled();
    expect(screen.queryByText("Session s-emulator")).not.toBeInTheDocument();
  });

  it("shows session creation errors for the selected device", async () => {
    const user = userEvent.setup();
    render(
      <DroidWebscrApp
        client={{
          createSession: async () => {
            throw new Error("socket closed");
          },
          listDevices: async () => [
            {
              authorizationState: "authorized",
              serial: "emulator-5554",
              transportKind: "emulator",
            },
          ],
        }}
        storage={createMemoryStorage()}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Android device emulator-5554" }));
    await user.click(screen.getByRole("button", { name: "Start" }));

    expect(await screen.findByText("socket closed")).toBeInTheDocument();
  });

  it("persists theme preference and exposes log drawer clear state", async () => {
    const user = userEvent.setup();
    const storage = createMemoryStorage();
    render(
      <DroidWebscrApp
        client={{
          createSession: async () => ({ sessionId: "s1", serial: "emulator-5554", token: "t1" }),
          listDevices: async () => [],
        }}
        initialLogs={["Agent ready", "No device selected"]}
        storage={storage}
      />,
    );

    expect(document.documentElement.dataset.theme).toBe("dark");
    await user.click(screen.getByRole("button", { name: "Light theme" }));

    expect(storage.getItem("droid-webscr.theme")).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    await user.click(screen.getByRole("button", { name: "Dark theme" }));

    expect(storage.getItem("droid-webscr.theme")).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");

    const logDrawer = screen.getByRole("region", { name: "Log drawer" });
    expect(within(logDrawer).getByText("Agent ready")).toBeInTheDocument();
    await user.click(within(logDrawer).getByRole("button", { name: "Clear logs" }));

    expect(within(logDrawer).getByText("No logs")).toBeInTheDocument();
  });

  it("uses browser localStorage when no storage override is provided", async () => {
    render(
      <DroidWebscrApp
        client={{
          createSession: async () => ({ sessionId: "s1", serial: "emulator-5554", token: "t1" }),
          listDevices: async () => [],
        }}
      />,
    );

    expect(await screen.findByText("No Android devices detected")).toBeInTheDocument();
    expect(window.localStorage.getItem("droid-webscr.theme")).toBe("dark");
  });
});
