import { StyleSheet, Text, View } from "react-native";

export default function ItemsScreen() {
  return (
    <View style={styles.container}>
      <Text>Items</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});
