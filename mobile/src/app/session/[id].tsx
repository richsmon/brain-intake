// BI-C2 session detail — the phone-side cockpit for one coding session: chat
// transcript from the JSONL event log, Edit diff cards and Bash command cards,
// a sticky Approve/Deny bar while a gate is waiting, the mode switch
// (gated / acceptEdits / auto), a follow-up message input, and the final summary + per-file diff
// stat on done. The screen POLLS events.json with the offset contract while
// focused; every re-focus replays from 0, so kill/reopen shows the full
// history with no gaps.

import { useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { DiffView } from "../../components/ds/diff-view";
import { SessionStateChip } from "../../components/ds/session-state-chip";
import { getSessionsApi } from "../../lib/brain";
import { diffForTool, diffStat, isEditTool, toolFilePath, type DiffLine } from "../../lib/diff";
import {
  formatUsageLine,
  isTerminal,
  parseUsage,
  PERMISSION_MODES,
  startEventsPoll,
  type PermissionMode,
  type SessionEvent,
  type SessionState,
  type SessionUsage,
} from "../../lib/sessions";
import { useTheme } from "../../theme";
import { fonts, labelTracking, radii, spacing, typeScale } from "../../theme/tokens";

type Item =
  | { type: "chat"; key: string; text: string }
  | { type: "user"; key: string; text: string }
  | { type: "tool"; key: string; toolName: string; input: Record<string, unknown> }
  | {
      type: "gate";
      key: string;
      requestId: string;
      toolName: string;
      input: Record<string, unknown>;
      decision?: string;
    }
  | { type: "sys"; key: string; text: string }
  | { type: "result"; key: string; outcome: string; summary?: string; usage?: SessionUsage; totalCostUsd?: number };

interface Derived {
  items: Item[];
  meta: { repo: string; model: string; permissionMode: string } | null;
  mode: PermissionMode;
  state: SessionState;
  pending: { requestId: string; toolName: string } | null;
  fileStats: { path: string; added: number; removed: number }[];
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function input(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

function toPermissionMode(v: string): PermissionMode {
  return v === "acceptEdits" || v === "auto" ? v : "gated";
}

/** Fold the raw event log into renderable items + live control state. */
export function deriveSession(events: SessionEvent[]): Derived {
  const decisions = new Map<string, string>();
  const gatedRequestIds = new Set<string>();
  for (const e of events) {
    if (e.event === "permission_resolved") decisions.set(str(e.requestId), str(e.decision));
    if (e.event === "permission_request") gatedRequestIds.add(str(e.requestId));
  }

  const items: Item[] = [];
  let meta: Derived["meta"] = null;
  let mode: PermissionMode = "gated";
  let state: SessionState = "created";
  let pending: Derived["pending"] = null;
  const fileStats = new Map<string, { added: number; removed: number }>();

  for (const e of events) {
    const key = `${e.index}`;
    switch (e.event) {
      case "status": {
        state = (str(e.status) || state) as SessionState;
        if (meta === null && typeof e.repo === "string") {
          meta = { repo: str(e.repo), model: str(e.model), permissionMode: str(e.permissionMode) };
          mode = toPermissionMode(str(e.permissionMode));
        }
        break;
      }
      case "chat_chunk":
        items.push({ type: "chat", key, text: str(e.text) });
        break;
      case "user_message":
        items.push({ type: "user", key, text: str(e.text) });
        break;
      case "tool_call": {
        const requestId = str(e.requestId);
        // Gated calls render as the richer gate card instead.
        if (!gatedRequestIds.has(requestId)) {
          items.push({ type: "tool", key, toolName: str(e.toolName), input: input(e.input) });
        }
        const toolName = str(e.toolName);
        const toolInput = input(e.input);
        if (isEditTool(toolName) && decisions.get(requestId) !== "denied" && decisions.get(requestId) !== "timeout") {
          const lines = diffForTool(toolName, toolInput);
          const path = toolFilePath(toolInput);
          if (lines && path) {
            const stat = diffStat(lines);
            const cur = fileStats.get(path) ?? { added: 0, removed: 0 };
            fileStats.set(path, { added: cur.added + stat.added, removed: cur.removed + stat.removed });
          }
        }
        break;
      }
      case "permission_request": {
        const requestId = str(e.requestId);
        const decision = decisions.get(requestId);
        items.push({
          type: "gate",
          key,
          requestId,
          toolName: str(e.toolName),
          input: input(e.input),
          ...(decision !== undefined ? { decision } : {}),
        });
        if (decision === undefined) pending = { requestId, toolName: str(e.toolName) };
        break;
      }
      case "mode":
        mode = toPermissionMode(str(e.mode));
        items.push({ type: "sys", key, text: `mode → ${str(e.mode)}` });
        break;
      case "result": {
        // BI-C5: per-run tokens + cost ride the result event (mirrored SDK shape).
        const usage = parseUsage(e.usage);
        items.push({
          type: "result",
          key,
          outcome: str(e.outcome),
          ...(typeof e.summary === "string" ? { summary: e.summary } : {}),
          ...(usage !== null ? { usage } : {}),
          ...(typeof e.total_cost_usd === "number" ? { totalCostUsd: e.total_cost_usd } : {}),
        });
        break;
      }
      default:
        break;
    }
  }

  if (state !== "waiting-approval") pending = null;

  return {
    items,
    meta,
    mode,
    state,
    pending,
    fileStats: [...fileStats.entries()].map(([path, s]) => ({ path, ...s })),
  };
}

function GateCard({ item }: { item: Extract<Item, { type: "gate" }> }) {
  const { colors } = useTheme();
  const lines: DiffLine[] | null = diffForTool(item.toolName, item.input);
  const command = typeof item.input.command === "string" ? item.input.command : null;
  const path = toolFilePath(item.input);
  const decisionColor =
    item.decision === "approved" ? colors.success : item.decision === undefined ? colors.stateNeedsHuman : colors.danger;
  return (
    <View style={[styles.card, { backgroundColor: colors.bgSurface, borderColor: decisionColor }]}>
      <View style={styles.cardHead}>
        <Text style={[styles.mono, { color: colors.ink3 }]}>
          {item.toolName}
          {path ? ` · ${path}` : ""}
        </Text>
        <Text style={[styles.mono, { color: decisionColor }]}>
          {item.decision ?? "needs approval"}
        </Text>
      </View>
      {lines ? <DiffView lines={lines} /> : null}
      {command !== null ? (
        <Text style={[styles.command, { color: colors.ink1, backgroundColor: colors.bgCanvas }]}>
          $ {command}
        </Text>
      ) : null}
    </View>
  );
}

function ToolCard({ item }: { item: Extract<Item, { type: "tool" }> }) {
  const { colors } = useTheme();
  const command = typeof item.input.command === "string" ? item.input.command : null;
  const path = toolFilePath(item.input);
  const lines = diffForTool(item.toolName, item.input);
  return (
    <View style={[styles.card, { backgroundColor: colors.bgSurface, borderColor: colors.line }]}>
      <Text style={[styles.mono, { color: colors.ink3 }]}>
        {item.toolName}
        {path ? ` · ${path}` : ""}
      </Text>
      {command !== null ? (
        <Text style={[styles.command, { color: colors.ink1, backgroundColor: colors.bgCanvas }]}>
          $ {command}
        </Text>
      ) : null}
      {lines ? <DiffView lines={lines} /> : null}
    </View>
  );
}

export default function SessionDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  useFocusEffect(
    useCallback(() => {
      // Fresh replay from offset 0 on every focus — the log is the truth.
      setEvents([]);
      let stop: (() => void) | null = null;
      let cancelled = false;
      void (async () => {
        const api = await getSessionsApi();
        if (!api || cancelled) return;
        stop = startEventsPoll(api, id, (page) => {
          if (page.events.length > 0) setEvents((prev) => [...prev, ...page.events]);
        });
      })();
      return () => {
        cancelled = true;
        stop?.();
      };
    }, [id]),
  );

  const derived = useMemo(() => deriveSession(events), [events]);

  async function act(fn: (api: NonNullable<Awaited<ReturnType<typeof getSessionsApi>>>) => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    try {
      const api = await getSessionsApi();
      if (!api) throw new Error("no token");
      await fn(api);
    } catch {
      Alert.alert("That didn't reach the mini", "Check the tailnet and try again.");
    } finally {
      setBusy(false);
    }
  }

  const pending = derived.pending;
  const active = !isTerminal(derived.state) && derived.state !== "created";

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.bgCanvas }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={styles.container}
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
      >
        <Text style={[styles.id, { color: colors.ink3 }]}>{id}</Text>
        <View style={styles.headRow}>
          <SessionStateChip state={derived.state} />
          {derived.meta ? (
            <Text style={[styles.mono, { color: colors.ink3 }]}>
              {derived.meta.repo} · {derived.meta.model}
            </Text>
          ) : null}
        </View>

        <View style={styles.modeRow}>
          <Text style={[styles.fieldLabel, { color: colors.ink3 }]}>Mode</Text>
          {PERMISSION_MODES.map((m) => {
            const activeMode = derived.mode === m;
            return (
              <Pressable
                key={m}
                accessibilityRole="button"
                accessibilityState={{ selected: activeMode }}
                disabled={!active || activeMode}
                onPress={() => void act((api) => api.setMode(id, m))}
                style={[
                  styles.modeChip,
                  {
                    borderColor: activeMode ? colors.accent : colors.line,
                    backgroundColor: activeMode ? colors.accentSoft : colors.bgSurface,
                  },
                ]}
              >
                <Text style={[styles.modeChipLabel, { color: activeMode ? colors.accent : colors.ink2 }]}>
                  {m}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {derived.items.map((item) => {
          switch (item.type) {
            case "chat":
              return (
                <View key={item.key} style={[styles.chat, { backgroundColor: colors.bgSurface, borderColor: colors.line }]}>
                  <Text style={[styles.chatText, { color: colors.ink1 }]}>{item.text}</Text>
                </View>
              );
            case "user":
              return (
                <View key={item.key} style={[styles.chat, styles.userChat, { backgroundColor: colors.accentSoft, borderColor: colors.accent }]}>
                  <Text style={[styles.chatText, { color: colors.ink1 }]}>{item.text}</Text>
                </View>
              );
            case "tool":
              return <ToolCard key={item.key} item={item} />;
            case "gate":
              return <GateCard key={item.key} item={item} />;
            case "sys":
              return (
                <Text key={item.key} style={[styles.sysLine, { color: colors.ink3 }]}>
                  {item.text}
                </Text>
              );
            case "result": {
              const usageLine = formatUsageLine(item.usage, item.totalCostUsd);
              return (
                <View
                  key={item.key}
                  style={[
                    styles.card,
                    {
                      backgroundColor: colors.bgSurface,
                      borderColor: item.outcome === "success" ? colors.stateBecame : colors.danger,
                    },
                  ]}
                >
                  <Text style={[styles.mono, { color: item.outcome === "success" ? colors.stateBecame : colors.danger }]}>
                    {item.outcome === "success" ? "✦ done" : "✕ error"}
                  </Text>
                  {item.summary ? (
                    <Text style={[styles.chatText, { color: colors.ink1 }]}>{item.summary}</Text>
                  ) : null}
                  {usageLine !== null ? (
                    <Text style={[styles.mono, { color: colors.ink3 }]}>{usageLine}</Text>
                  ) : null}
                  {derived.fileStats.length > 0 ? (
                    <View style={styles.statBlock}>
                      {derived.fileStats.map((s) => (
                        <Text key={s.path} style={[styles.mono, { color: colors.ink2 }]}>
                          {s.path}{"  "}
                          <Text style={{ color: colors.success }}>+{s.added}</Text>{" "}
                          <Text style={{ color: colors.danger }}>-{s.removed}</Text>
                        </Text>
                      ))}
                    </View>
                  ) : null}
                </View>
              );
            }
          }
        })}
      </ScrollView>

      {pending ? (
        <View style={[styles.stickyBar, { backgroundColor: colors.bgSurface, borderTopColor: colors.line }]}>
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={() => void act((api) => api.approve(id, pending.requestId))}
            style={({ pressed }) => [
              styles.primary,
              styles.action,
              { backgroundColor: pressed ? colors.accentStrong : colors.accent },
            ]}
          >
            <Text style={[styles.primaryLabel, { color: colors.inkInverse }]}>
              {busy ? "Working…" : "Approve"}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={() => void act((api) => api.deny(id, pending.requestId))}
            style={[styles.secondary, styles.action, { borderColor: colors.danger }]}
          >
            <Text style={[styles.secondaryLabel, { color: colors.danger }]}>Deny</Text>
          </Pressable>
        </View>
      ) : active ? (
        <View style={[styles.stickyBar, { backgroundColor: colors.bgSurface, borderTopColor: colors.line }]}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder="Message the agent…"
            placeholderTextColor={colors.ink3}
            multiline
            style={[
              styles.messageInput,
              { borderColor: colors.line, backgroundColor: colors.bgSurface2, color: colors.ink1 },
            ]}
          />
          <Pressable
            accessibilityRole="button"
            disabled={busy || draft.trim().length === 0}
            onPress={() => {
              const text = draft.trim();
              setDraft("");
              void act((api) => api.sendMessage(id, text));
            }}
            style={({ pressed }) => [
              styles.primary,
              styles.send,
              {
                backgroundColor:
                  draft.trim().length === 0 ? colors.bgSurface2 : pressed ? colors.accentStrong : colors.accent,
              },
            ]}
          >
            <Text
              style={[
                styles.primaryLabel,
                { color: draft.trim().length === 0 ? colors.ink3 : colors.inkInverse },
              ]}
            >
              Send
            </Text>
          </Pressable>
        </View>
      ) : null}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: spacing.s4,
    gap: spacing.s3,
  },
  id: {
    fontFamily: fonts.mono,
    fontSize: typeScale.caption,
  },
  headRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.s3,
  },
  modeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.s2,
  },
  fieldLabel: {
    fontFamily: fonts.mono,
    fontSize: typeScale.label,
    letterSpacing: labelTracking,
    textTransform: "uppercase",
    fontWeight: "600",
  },
  modeChip: {
    borderWidth: 1,
    borderRadius: radii.chip,
    paddingHorizontal: spacing.s3,
    paddingVertical: spacing.s1 + 2,
  },
  modeChipLabel: {
    fontSize: typeScale.bodySm,
    fontWeight: "600",
  },
  chat: {
    borderWidth: 1,
    borderRadius: radii.card,
    padding: spacing.s3,
  },
  userChat: {
    alignSelf: "flex-end",
    maxWidth: "88%",
  },
  chatText: {
    fontSize: typeScale.bodySm,
    lineHeight: typeScale.bodySm * 1.45,
  },
  card: {
    borderWidth: 1,
    borderRadius: radii.card,
    padding: spacing.s3,
    gap: spacing.s2,
  },
  cardHead: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: spacing.s2,
  },
  mono: {
    fontFamily: fonts.mono,
    fontSize: typeScale.label,
  },
  command: {
    fontFamily: fonts.mono,
    fontSize: typeScale.caption,
    lineHeight: typeScale.caption * 1.5,
    borderRadius: radii.control,
    paddingHorizontal: spacing.s2,
    paddingVertical: spacing.s2 - 2,
    overflow: "hidden",
  },
  sysLine: {
    fontFamily: fonts.mono,
    fontSize: typeScale.label,
    textAlign: "center",
  },
  statBlock: {
    gap: 2,
  },
  stickyBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: spacing.s2,
    borderTopWidth: StyleSheet.hairlineWidth,
    padding: spacing.s3,
    paddingBottom: spacing.thumbBottom,
  },
  action: {
    flex: 1,
  },
  primary: {
    minHeight: spacing.hitMin,
    borderRadius: radii.control,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryLabel: {
    fontSize: typeScale.body,
    fontWeight: "600",
  },
  secondary: {
    minHeight: spacing.hitMin,
    borderWidth: 1,
    borderRadius: radii.control,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryLabel: {
    fontSize: typeScale.body,
    fontWeight: "600",
  },
  messageInput: {
    flex: 1,
    minHeight: spacing.hitMin,
    maxHeight: 120,
    borderWidth: 1,
    borderRadius: radii.control,
    paddingHorizontal: spacing.s3,
    paddingVertical: spacing.s2,
    fontSize: typeScale.bodySm,
  },
  send: {
    paddingHorizontal: spacing.s4,
  },
});
