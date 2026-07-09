// Act — approve-first dialogue with the brain's agents. v1 ships the mode with
// an honest empty state; A1 questions + A2 approvals arrive with IN-4.

import { View } from "react-native";

import { EmptyState } from "../../components/ds/empty-state";
import { ScreenHeader } from "../../components/ds/screen-header";

export default function ActScreen() {
  return (
    <View style={{ flex: 1 }}>
      <ScreenHeader title="Act" />
      <EmptyState text="Nothing needs you. I'll ask when something does." />
    </View>
  );
}
