// Coding (BI-C2) — the control layer over coding agents on the mini: the
// session list (live states) and the New Session sheet (repo → prompt → model
// → effort → mode). Prompt input is text-only in this slice: the capture voice
// component records audio for server-side transcription and doesn't drop into
// a TextInput flow trivially.

import { router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import {
  Alert,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { EmptyState } from "../../components/ds/empty-state";
import { ScreenHeader } from "../../components/ds/screen-header";
import { SessionStateChip } from "../../components/ds/session-state-chip";
import { getSessionsApi } from "../../lib/brain";
import {
  PERMISSION_MODES,
  permissionModeLabel,
  type PermissionMode,
  type SessionSummary,
  type SessionsMeta,
} from "../../lib/sessions";
import { useTheme } from "../../theme";
import { fonts, labelTracking, radii, spacing, typeScale } from "../../theme/tokens";

// Sensible fallbacks only — the server's /sessions/meta is the real source.
const FALLBACK_META: SessionsMeta = {
  repos: [],
  models: [
    { id: "claude-fable-5", label: "Fable" },
    { id: "claude-opus-4-8", label: "Opus" },
    { id: "claude-sonnet-5", label: "Sonnet" },
    { id: "claude-haiku-4-5", label: "Haiku" },
  ],
  efforts: ["low", "medium", "high", "xhigh", "max"],
};

function PickerRow<T extends string>({
  label,
  options,
  selected,
  labelFor,
  onSelect,
}: {
  label: string;
  options: T[];
  selected: T | null;
  labelFor?: (option: T) => string;
  onSelect: (option: T) => void;
}) {
  const { colors } = useTheme();
  return (
    <View style={styles.pickerBlock}>
      <Text style={[styles.fieldLabel, { color: colors.ink3 }]}>{label}</Text>
      <View style={styles.chipRow}>
        {options.map((option) => {
          const active = option === selected;
          return (
            <Pressable
              key={option}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              onPress={() => onSelect(option)}
              style={[
                styles.pickChip,
                {
                  borderColor: active ? colors.accent : colors.line,
                  backgroundColor: active ? colors.accentSoft : colors.bgSurface,
                },
              ]}
            >
              <Text style={[styles.pickChipLabel, { color: active ? colors.accent : colors.ink2 }]}>
                {labelFor ? labelFor(option) : option}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function NewSessionSheet({
  visible,
  meta,
  onClose,
  onCreated,
}: {
  visible: boolean;
  meta: SessionsMeta;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { colors } = useTheme();
  const [repo, setRepo] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState<string | null>(meta.models[0]?.id ?? null);
  const [effort, setEffort] = useState<string | null>(null);
  const [mode, setMode] = useState<PermissionMode>("gated");
  const [starting, setStarting] = useState(false);

  const ready = repo !== null && model !== null && prompt.trim().length > 0 && !starting;

  async function start() {
    if (!ready || repo === null || model === null) return;
    setStarting(true);
    try {
      const api = await getSessionsApi();
      if (!api) throw new Error("no token");
      const { id } = await api.create({
        repo,
        prompt: prompt.trim(),
        model,
        permissionMode: mode,
        ...(effort !== null ? { effort } : {}),
      });
      setPrompt("");
      setStarting(false);
      onCreated(id);
    } catch {
      setStarting(false);
      Alert.alert("Session didn't start", "Check the tailnet and the sessions token.");
    }
  }

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.sheetBackdrop}>
        <View style={[styles.sheet, { backgroundColor: colors.bgSurface, borderColor: colors.line }]}>
          <ScrollView contentContainerStyle={styles.sheetContent}>
            <View style={styles.sheetHead}>
              <Text style={[styles.sheetTitle, { color: colors.ink1 }]}>New Session</Text>
              <Pressable accessibilityRole="button" onPress={onClose} hitSlop={12}>
                <Text style={[styles.sheetClose, { color: colors.ink3 }]}>Close</Text>
              </Pressable>
            </View>

            <PickerRow label="Repo" options={meta.repos} selected={repo} onSelect={setRepo} />

            <View style={styles.pickerBlock}>
              <Text style={[styles.fieldLabel, { color: colors.ink3 }]}>Prompt</Text>
              <TextInput
                value={prompt}
                onChangeText={setPrompt}
                multiline
                placeholder="What should the agent do?"
                placeholderTextColor={colors.ink3}
                style={[
                  styles.promptInput,
                  { borderColor: colors.line, backgroundColor: colors.bgSurface2, color: colors.ink1 },
                ]}
              />
            </View>

            <PickerRow
              label="Model"
              options={meta.models.map((m) => m.id)}
              selected={model}
              labelFor={(id) => meta.models.find((m) => m.id === id)?.label ?? id}
              onSelect={setModel}
            />

            <PickerRow label="Effort" options={meta.efforts} selected={effort} onSelect={setEffort} />

            <PickerRow
              label="Mode"
              options={[...PERMISSION_MODES]}
              selected={mode}
              labelFor={permissionModeLabel}
              onSelect={setMode}
            />

            <Pressable
              accessibilityRole="button"
              disabled={!ready}
              onPress={() => void start()}
              style={({ pressed }) => [
                styles.start,
                {
                  backgroundColor: !ready ? colors.bgSurface2 : pressed ? colors.accentStrong : colors.accent,
                },
              ]}
            >
              <Text style={[styles.startLabel, { color: ready ? colors.inkInverse : colors.ink3 }]}>
                {starting ? "Starting…" : "Start session"}
              </Text>
            </Pressable>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

export default function CodingScreen() {
  const { colors } = useTheme();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [meta, setMeta] = useState<SessionsMeta>(FALLBACK_META);
  const [hasToken, setHasToken] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  const load = useCallback(async () => {
    const api = await getSessionsApi();
    if (!api) {
      setHasToken(false);
      return;
    }
    setHasToken(true);
    try {
      const [list, serverMeta] = await Promise.all([api.list(), api.meta().catch(() => null)]);
      setSessions([...list].reverse()); // newest first — ids sort by date
      if (serverMeta) setMeta(serverMeta);
    } catch {
      // Offline — keep whatever we showed last.
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bgCanvas }}>
      <ScreenHeader
        title="Coding"
        right={
          hasToken ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => setSheetOpen(true)}
              style={({ pressed }) => [
                styles.newButton,
                { backgroundColor: pressed ? colors.accentStrong : colors.accent },
              ]}
            >
              <Text style={[styles.newButtonLabel, { color: colors.inkInverse }]}>+ New</Text>
            </Pressable>
          ) : undefined
        }
      />
      {!hasToken ? (
        <EmptyState text="Coding needs the sessions token. Add it in Settings and I'll show the sessions here." />
      ) : (
        <FlatList
          data={sessions}
          keyExtractor={(s) => s.id}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => router.push({ pathname: "/session/[id]", params: { id: item.id } })}
              style={({ pressed }) => [
                styles.row,
                { borderBottomColor: colors.line },
                pressed && { backgroundColor: colors.bgSurface2 },
              ]}
            >
              <Text numberOfLines={2} style={[styles.rowPrompt, { color: colors.ink1 }]}>
                {item.prompt}
              </Text>
              <View style={styles.rowMeta}>
                <SessionStateChip state={item.state} />
                <Text style={[styles.rowMono, { color: colors.ink3 }]}>{item.repo}</Text>
                <View style={styles.spacer} />
                <Text style={[styles.rowMono, { color: colors.ink3 }]}>{item.model}</Text>
              </View>
            </Pressable>
          )}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
          ListEmptyComponent={
            <EmptyState text="No sessions yet. Start one and watch the agent work from here." />
          }
        />
      )}
      <NewSessionSheet
        visible={sheetOpen}
        meta={meta}
        onClose={() => setSheetOpen(false)}
        onCreated={(id) => {
          setSheetOpen(false);
          void load();
          router.push({ pathname: "/session/[id]", params: { id } });
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  newButton: {
    borderRadius: radii.control,
    paddingHorizontal: spacing.s3,
    paddingVertical: spacing.s2,
    minHeight: 36,
    justifyContent: "center",
  },
  newButtonLabel: {
    fontSize: typeScale.bodySm,
    fontWeight: "600",
  },
  row: {
    paddingHorizontal: spacing.s4,
    paddingVertical: spacing.s3,
    gap: spacing.s2,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowPrompt: {
    fontSize: typeScale.body,
    fontWeight: "600",
    lineHeight: typeScale.body * 1.3,
  },
  rowMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.s2,
  },
  rowMono: {
    fontFamily: fonts.mono,
    fontSize: typeScale.label,
  },
  spacer: {
    flex: 1,
  },
  sheetBackdrop: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  sheet: {
    maxHeight: "88%",
    borderTopLeftRadius: radii.sheet,
    borderTopRightRadius: radii.sheet,
    borderWidth: 1,
  },
  sheetContent: {
    padding: spacing.s4,
    paddingBottom: spacing.s8,
    gap: spacing.s4,
  },
  sheetHead: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  sheetTitle: {
    fontSize: typeScale.heading,
    fontWeight: "600",
  },
  sheetClose: {
    fontFamily: fonts.mono,
    fontSize: typeScale.bodySm,
  },
  pickerBlock: {
    gap: spacing.s2,
  },
  fieldLabel: {
    fontFamily: fonts.mono,
    fontSize: typeScale.label,
    letterSpacing: labelTracking,
    textTransform: "uppercase",
    fontWeight: "600",
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.s2,
  },
  pickChip: {
    borderWidth: 1,
    borderRadius: radii.chip,
    paddingHorizontal: spacing.s3,
    paddingVertical: spacing.s2,
  },
  pickChipLabel: {
    fontSize: typeScale.bodySm,
    fontWeight: "600",
  },
  promptInput: {
    minHeight: 88,
    borderWidth: 1,
    borderRadius: radii.control,
    padding: spacing.s3,
    textAlignVertical: "top",
    fontSize: typeScale.bodySm,
    lineHeight: typeScale.bodySm * 1.4,
  },
  start: {
    minHeight: spacing.hitMin,
    borderRadius: radii.control,
    alignItems: "center",
    justifyContent: "center",
  },
  startLabel: {
    fontSize: typeScale.body,
    fontWeight: "600",
  },
});
