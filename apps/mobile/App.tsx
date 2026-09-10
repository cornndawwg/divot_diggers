import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, SafeAreaView, StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { api, forgetToken, storedToken, type Me } from './src/api';
import { Home, Join, SignIn } from './src/screens';
import { theme } from './src/theme';

/**
 * Where the app is, in one value.
 *
 * There is no router yet on purpose. Three states with one path between them do not need one,
 * and a dependency added before it earns its place is a dependency you keep forever. The
 * scorecard in task 3.4 is where real navigation starts, and that is when to choose one.
 */
type State =
  | { kind: 'starting' }
  | { kind: 'signed-out' }
  | { kind: 'no-event'; me: Me }
  | { kind: 'ready'; me: Me };

export default function App() {
  const [state, setState] = useState<State>({ kind: 'starting' });

  const refresh = useCallback(async () => {
    if ((await storedToken()) === null) {
      setState({ kind: 'signed-out' });
      return;
    }
    try {
      const me = await api.me();
      setState(me.events.length === 0 ? { kind: 'no-event', me } : { kind: 'ready', me });
    } catch {
      // A token the server no longer accepts is worth nothing; start again rather than
      // leaving somebody stuck on a screen that cannot load.
      await forgetToken();
      setState({ kind: 'signed-out' });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signOut = useCallback(async () => {
    await api.signOut();
    setState({ kind: 'signed-out' });
  }, []);

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="dark" />
      {state.kind === 'starting' ? (
        <View style={styles.centre}>
          <ActivityIndicator size="large" color={theme.green} />
        </View>
      ) : state.kind === 'signed-out' ? (
        <SignIn onSignedIn={() => void refresh()} />
      ) : state.kind === 'no-event' ? (
        <Join onJoined={() => void refresh()} onSignOut={() => void signOut()} />
      ) : (
        <Home me={state.me} onSignOut={() => void signOut()} />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.ground },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
