// Reviews (MC-R1) — the MC review surface: open PRs across the market-clue
// org AND the founder's personal repos (MC-R2), tap one, pick model + effort,
// launch. The server runs the review as a normal gated coding session, so
// "Launch review" drops straight into the existing session detail. Reached
// from the Coding tab's header. Rows show `owner/repo` since the list now
// spans two owners. MC-R3: rows with a past review session show a tappable
// "reviewed 2h ago · done" line that reopens that session's detail directly.

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
  View,
} from "react-native";

import { EmptyState } from "../components/ds/empty-state";
import { ApiError } from "../lib/api";
import { getSessionsApi } from "../lib/brain";
import { formatAge, formatReviewedLine, type ReviewPr, type SessionsMeta } from "../lib/sessions";
import { useTheme } from "../theme";
import { fonts, labelTracking, radii, spacing, typeScale } from "../theme/tokens";

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

function LaunchSheet({
  pr,
  meta,
  onClose,
  onLaunched,
}: {
  pr: ReviewPr | null;
  meta: SessionsMeta;
  onClose: () => void;
  onLaunched: (sessionId: string) => void;
}) {
  const { colors } = useTheme();
  const [model, setModel] = useState<string | null>(meta.models[0]?.id ?? null);
  const [effort, setEffort] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);

  const ready = pr !== null && model !== null && !launching;

  async function launch() {
    if (!ready || pr === null || model === null) return;
    setLaunching(true);
    try {
      const api = await getSessionsApi();
      if (!api) throw new Error("no token");
      const { sessionId } = await api.launchReview({
        owner: pr.owner,
        repo: pr.repo,
        pr: pr.number,
        model,
        ...(effort !== null ? { effort } : {}),
      });
      setLaunching(false);
      onLaunched(sessionId);
    } catch (err) {
      setLaunching(false);
      if (err instanceof ApiError && err.status === 409) {
        Alert.alert(
          "No local checkout",
          `The host has no checkout of ${pr.owner}/${pr.repo}. Clone it there first.`,
        );
      } else {
        Alert.alert("Review didn't start", "Check the tailnet and the sessions token.");
      }
    }
  }

  return (
    <Modal visible={pr !== null} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.sheetBackdrop}>
        <View style={[styles.sheet, { backgroundColor: colors.bgSurface, borderColor: colors.line }]}>
          <ScrollView contentContainerStyle={styles.sheetContent}>
            <View style={styles.sheetHead}>
              <Text style={[styles.sheetTitle, { color: colors.ink1 }]}>Launch Review</Text>
              <Pressable accessibilityRole="button" onPress={onClose} hitSlop={12}>
                <Text style={[styles.sheetClose, { color: colors.ink3 }]}>Close</Text>
              </Pressable>
            </View>

            {pr !== null ? (
              <View style={styles.prSummary}>
                <Text style={[styles.rowMono, { color: colors.ink3 }]}>
                  {pr.owner}/{pr.repo} #{pr.number} · {pr.branch}
                </Text>
                <Text style={[styles.rowTitle, { color: colors.ink1 }]}>{pr.title}</Text>
              </View>
            ) : null}

            <PickerRow
              label="Model"
              options={meta.models.map((m) => m.id)}
              selected={model}
              labelFor={(id) => meta.models.find((m) => m.id === id)?.label ?? id}
              onSelect={setModel}
            />

            <PickerRow label="Effort" options={meta.efforts} selected={effort} onSelect={setEffort} />

            <Pressable
              accessibilityRole="button"
              disabled={!ready}
              onPress={() => void launch()}
              style={({ pressed }) => [
                styles.launch,
                {
                  backgroundColor: !ready ? colors.bgSurface2 : pressed ? colors.accentStrong : colors.accent,
                },
              ]}
            >
              <Text style={[styles.launchLabel, { color: ready ? colors.inkInverse : colors.ink3 }]}>
                {launching ? "Launching…" : "Launch review"}
              </Text>
            </Pressable>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

export default function ReviewsScreen() {
  const { colors } = useTheme();
  const [prs, setPrs] = useState<ReviewPr[]>([]);
  const [meta, setMeta] = useState<SessionsMeta>(FALLBACK_META);
  const [hasToken, setHasToken] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [picked, setPicked] = useState<ReviewPr | null>(null);

  const load = useCallback(async () => {
    const api = await getSessionsApi();
    if (!api) {
      setHasToken(false);
      return;
    }
    setHasToken(true);
    try {
      const [list, serverMeta] = await Promise.all([api.reviewPrs(), api.meta().catch(() => null)]);
      setPrs(list);
      if (serverMeta) setMeta(serverMeta);
      setLoaded(true);
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
      {!hasToken ? (
        <EmptyState text="Reviews need the sessions token. Add it in Settings and I'll list the open PRs here." />
      ) : (
        <FlatList
          data={prs}
          keyExtractor={(pr) => `${pr.owner}/${pr.repo}#${pr.number}`}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => setPicked(item)}
              style={({ pressed }) => [
                styles.row,
                { borderBottomColor: colors.line },
                pressed && { backgroundColor: colors.bgSurface2 },
              ]}
            >
              <Text style={[styles.rowMono, { color: colors.ink3 }]}>
                {item.owner}/{item.repo} #{item.number}
              </Text>
              <Text numberOfLines={2} style={[styles.rowTitle, { color: colors.ink1 }]}>
                {item.title}
              </Text>
              <View style={styles.rowMeta}>
                <Text style={[styles.rowMono, { color: colors.ink3 }]}>{item.author}</Text>
                <View style={styles.spacer} />
                <Text style={[styles.rowMono, { color: colors.success }]}>+{item.additions}</Text>
                <Text style={[styles.rowMono, { color: colors.danger }]}>-{item.deletions}</Text>
                <Text style={[styles.rowMono, { color: colors.ink3 }]}>{formatAge(item.updatedAt)}</Text>
              </View>
              {item.lastReview ? (
                // MC-R3: the list remembers — tap the reviewed line to reopen
                // that session directly; tapping the row still launches a new one.
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Open review session for ${item.owner}/${item.repo} #${item.number}`}
                  hitSlop={8}
                  onPress={() =>
                    router.push({ pathname: "/session/[id]", params: { id: item.lastReview!.sessionId } })
                  }
                  style={styles.reviewedLine}
                >
                  <Text style={[styles.rowMono, { color: colors.accent }]}>
                    {formatReviewedLine(item.lastReview)}
                  </Text>
                </Pressable>
              ) : null}
            </Pressable>
          )}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
          ListEmptyComponent={
            loaded ? <EmptyState text="No open PRs across your repos right now." /> : null
          }
        />
      )}
      <LaunchSheet
        pr={picked}
        meta={meta}
        onClose={() => setPicked(null)}
        onLaunched={(sessionId) => {
          setPicked(null);
          router.push({ pathname: "/session/[id]", params: { id: sessionId } });
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    paddingHorizontal: spacing.s4,
    paddingVertical: spacing.s3,
    gap: spacing.s2,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowTitle: {
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
  reviewedLine: {
    alignSelf: "flex-start",
  },
  prSummary: {
    gap: spacing.s2,
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
  launch: {
    minHeight: spacing.hitMin,
    borderRadius: radii.control,
    alignItems: "center",
    justifyContent: "center",
  },
  launchLabel: {
    fontSize: typeScale.body,
    fontWeight: "600",
  },
});
