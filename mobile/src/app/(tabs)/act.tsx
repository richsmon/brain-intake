// Act — approve-first dialogue with the brain's agents. A1 questions (answer
// in text; the file in questions/ is the state), A2 approvals (loop PRs with
// the verifier's verdict; Approve = the founder merging remotely, behind an
// explicit confirm), A3 fleet glance (read-only status line — the kill switch
// stays a v2 decision).

import { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { EmptyState } from "../../components/ds/empty-state";
import { ScreenHeader } from "../../components/ds/screen-header";
import type { Approval, CloudApproval, Fleet, Question } from "../../lib/api";
import { getApi } from "../../lib/brain";
import { useTheme } from "../../theme";
import { fonts, labelTracking, radii, spacing, typeScale } from "../../theme/tokens";

function SectionLabel({ text }: { text: string }) {
  const { colors } = useTheme();
  return <Text style={[styles.sectionLabel, { color: colors.ink3 }]}>{text}</Text>;
}

function FleetLine({ fleet }: { fleet: Fleet | null }) {
  const { colors } = useTheme();
  if (!fleet) return null;
  const dotColor = fleet.loopDisabled ? colors.danger : colors.stateBecame;
  const text = fleet.loopDisabled
    ? "fleet halted (kill switch on the host)"
    : `loops live · last report ${fleet.lastReport ?? "none yet"}`;
  return (
    <View style={[styles.fleet, { backgroundColor: colors.bgSurface, borderColor: colors.line }]}>
      <View style={[styles.fleetDot, { backgroundColor: dotColor }]} />
      <Text numberOfLines={1} style={[styles.fleetText, { color: colors.ink2 }]}>
        {text}
      </Text>
    </View>
  );
}

function CloudApprovalCard({ pending, onDone }: { pending: CloudApproval; onDone: () => void }) {
  const { colors } = useTheme();
  const [busy, setBusy] = useState(false);

  function act(kind: "approve" | "keep") {
    void (async () => {
      setBusy(true);
      try {
        const api = await getApi();
        await (kind === "approve" ? api.cloudApprove(pending.id) : api.keepLocal(pending.id));
        onDone();
      } catch {
        setBusy(false);
        Alert.alert("That didn't reach the brain", "Check the tailnet and try again.");
      }
    })();
  }

  return (
    <View style={[styles.card, { backgroundColor: colors.bgSurface, borderColor: colors.line }]}>
      <View style={styles.cardHead}>
        <Text style={[styles.meta, { color: colors.stateRouted }]}>↑ cloud approval</Text>
        <Text style={[styles.meta, { color: colors.ink3 }]}>{pending.reason}</Text>
      </View>
      <Text style={[styles.cardTitle, { color: colors.ink1 }]}>{pending.title}</Text>
      <Text style={[styles.cardBody, { color: colors.ink2 }]}>
        I couldn&apos;t place this locally. Send it to Claude for a second opinion?
      </Text>
      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={() => act("approve")}
          style={({ pressed }) => [
            styles.primary,
            styles.action,
            { backgroundColor: pressed ? colors.accentStrong : colors.accent },
          ]}
        >
          <Text style={[styles.primaryLabel, { color: colors.inkInverse }]}>
            {busy ? "Working…" : "Ask @claude"}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={() => act("keep")}
          style={[styles.secondary, styles.action, { borderColor: colors.lineStrong }]}
        >
          <Text style={[styles.secondaryLabel, { color: colors.ink1 }]}>Keep local</Text>
        </Pressable>
      </View>
    </View>
  );
}

function QuestionCard({ question, onAnswered }: { question: Question; onAnswered: () => void }) {
  const { colors } = useTheme();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await (await getApi()).answerQuestion(question.id, text);
      onAnswered();
    } catch {
      setSending(false);
      Alert.alert("Answer didn't reach the brain", "Check the tailnet and try again.");
    }
  }

  return (
    <View style={[styles.card, { backgroundColor: colors.bgSurface, borderColor: colors.line }]}>
      <View style={styles.cardHead}>
        <Text style={[styles.needsHuman, { color: colors.stateNeedsHuman }]}>● needs-human</Text>
        {question.date ? (
          <Text style={[styles.meta, { color: colors.ink3 }]}>{question.date}</Text>
        ) : null}
      </View>
      <Text style={[styles.cardTitle, { color: colors.ink1 }]}>{question.title}</Text>
      {question.body ? (
        <Text style={[styles.cardBody, { color: colors.ink2 }]} numberOfLines={6}>
          {question.body}
        </Text>
      ) : null}
      <TextInput
        value={draft}
        onChangeText={setDraft}
        placeholder="Answer…"
        placeholderTextColor={colors.ink3}
        multiline
        style={[
          styles.answerInput,
          { borderColor: colors.line, backgroundColor: colors.bgSurface2, color: colors.ink1 },
        ]}
      />
      {draft.trim() ? (
        <Pressable
          accessibilityRole="button"
          onPress={send}
          style={({ pressed }) => [
            styles.primary,
            { backgroundColor: pressed ? colors.accentStrong : colors.accent },
          ]}
        >
          <Text style={[styles.primaryLabel, { color: colors.inkInverse }]}>
            {sending ? "Sending…" : "Send answer"}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function ApproveCard({ approval, onDone }: { approval: Approval; onDone: () => void }) {
  const { colors } = useTheme();
  const [busy, setBusy] = useState(false);

  function act(kind: "approve" | "reject") {
    const verb = kind === "approve" ? "Merge" : "Close";
    Alert.alert(`${verb} PR #${approval.number}?`, approval.title, [
      { text: "Cancel", style: "cancel" },
      {
        text: verb,
        style: kind === "reject" ? "destructive" : "default",
        onPress: () => {
          void (async () => {
            setBusy(true);
            try {
              const api = await getApi();
              await (kind === "approve" ? api.approvePr(approval.number) : api.rejectPr(approval.number));
              onDone();
            } catch {
              setBusy(false);
              Alert.alert(`${verb} failed`, "gh on the host said no — check the PR on GitHub.");
            }
          })();
        },
      },
    ]);
  }

  const verdictPass = approval.verdict?.includes("PASS");

  return (
    <View style={[styles.card, { backgroundColor: colors.bgSurface, borderColor: colors.line }]}>
      <View style={styles.cardHead}>
        <Text style={[styles.meta, { color: colors.ink3 }]}>
          PR #{approval.number} · {approval.branch}
        </Text>
      </View>
      <Text style={[styles.cardTitle, { color: colors.ink1 }]}>{approval.title}</Text>
      {approval.verdict ? (
        <Text
          style={[
            styles.verdict,
            {
              color: verdictPass ? colors.stateBecame : colors.stateNeedsHuman,
              backgroundColor: verdictPass ? colors.stateBecameSoft : colors.stateNeedsHumanSoft,
            },
          ]}
        >
          {approval.verdict}
        </Text>
      ) : null}
      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={() => act("approve")}
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
          onPress={() => act("reject")}
          style={[styles.secondary, styles.action, { borderColor: colors.lineStrong }]}
        >
          <Text style={[styles.secondaryLabel, { color: colors.ink1 }]}>Reject</Text>
        </Pressable>
      </View>
    </View>
  );
}

export default function ActScreen() {
  const { colors } = useTheme();
  const [questions, setQuestions] = useState<Question[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [cloudApprovals, setCloudApprovals] = useState<CloudApproval[]>([]);
  const [fleet, setFleet] = useState<Fleet | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const api = await getApi();
      const [qs, fl, ca] = await Promise.all([
        api.listQuestions(),
        api.fleet(),
        api.listCloudApprovals().catch(() => []),
      ]);
      setQuestions(qs);
      setFleet(fl);
      setCloudApprovals(ca);
      setApprovals(await api.listApprovals());
    } catch {
      // Offline — Act simply has nothing actionable to show.
    }
  }, []);

  useEffect(() => {
    // On-mount load; every setState inside happens after an await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const empty = questions.length === 0 && approvals.length === 0 && cloudApprovals.length === 0;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bgCanvas }}>
      <ScreenHeader title="Act" />
      <ScrollView
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
      >
        <FleetLine fleet={fleet} />
        {empty ? (
          <EmptyState text="Nothing needs you. I'll ask when something does." />
        ) : (
          <>
            {cloudApprovals.length > 0 ? (
              <SectionLabel text={`Cloud approvals · ${cloudApprovals.length}`} />
            ) : null}
            {cloudApprovals.map((pending) => (
              <CloudApprovalCard key={pending.id} pending={pending} onDone={() => void load()} />
            ))}
            {approvals.length > 0 ? <SectionLabel text={`Approvals · ${approvals.length}`} /> : null}
            {approvals.map((approval) => (
              <ApproveCard key={approval.number} approval={approval} onDone={() => void load()} />
            ))}
            {questions.length > 0 ? <SectionLabel text={`Questions · ${questions.length}`} /> : null}
            {questions.map((question) => (
              <QuestionCard key={question.id} question={question} onAnswered={() => void load()} />
            ))}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  list: {
    paddingHorizontal: spacing.s4,
    paddingBottom: spacing.s4,
    gap: spacing.s3,
  },
  sectionLabel: {
    fontFamily: fonts.mono,
    fontSize: typeScale.label - 1,
    letterSpacing: labelTracking,
    textTransform: "uppercase",
    fontWeight: "600",
    marginTop: spacing.s1,
  },
  fleet: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.s2,
    borderWidth: 1,
    borderRadius: radii.card,
    paddingHorizontal: spacing.s3,
    paddingVertical: spacing.s2 + 2,
  },
  fleetDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  fleetText: {
    flex: 1,
    fontFamily: fonts.mono,
    fontSize: typeScale.label,
  },
  card: {
    borderWidth: 1,
    borderRadius: radii.card,
    padding: spacing.s3 + 2,
    gap: spacing.s2 + 2,
  },
  cardHead: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  needsHuman: {
    fontFamily: fonts.mono,
    fontSize: typeScale.label,
  },
  meta: {
    fontFamily: fonts.mono,
    fontSize: typeScale.label,
  },
  cardTitle: {
    fontSize: typeScale.body,
    fontWeight: "600",
    lineHeight: typeScale.body * 1.35,
  },
  cardBody: {
    fontSize: typeScale.bodySm,
    lineHeight: typeScale.bodySm * 1.45,
  },
  verdict: {
    fontFamily: fonts.mono,
    fontSize: typeScale.label,
    lineHeight: typeScale.label * 1.5,
    borderRadius: radii.control,
    paddingHorizontal: spacing.s2 + 2,
    paddingVertical: spacing.s2 - 2,
    overflow: "hidden",
  },
  answerInput: {
    minHeight: 56,
    borderWidth: 1,
    borderRadius: radii.control,
    padding: spacing.s3 - 2,
    textAlignVertical: "top",
    fontSize: typeScale.bodySm,
    lineHeight: typeScale.bodySm * 1.4,
  },
  actions: {
    flexDirection: "row",
    gap: spacing.s2,
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
    fontSize: typeScale.bodySm,
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
    fontSize: typeScale.bodySm,
    fontWeight: "600",
  },
});
