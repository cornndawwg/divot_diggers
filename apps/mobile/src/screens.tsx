import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { api, ApiError, type Me } from './api';
import { theme } from './theme';

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.ground },
  pad: { padding: 20, gap: 14 },
  title: { fontSize: 30, fontWeight: '700', color: theme.ink, marginTop: 8 },
  lede: { fontSize: 17, lineHeight: 24, color: theme.inkSoft },
  label: { fontSize: 15, fontWeight: '600', color: theme.ink, marginBottom: 4 },
  input: {
    minHeight: theme.tap,
    borderWidth: 1,
    borderColor: theme.line,
    borderRadius: theme.radius,
    backgroundColor: theme.paper,
    paddingHorizontal: 14,
    fontSize: 18,
    color: theme.ink,
  },
  codeInput: { fontSize: 30, letterSpacing: 8, textAlign: 'center', fontWeight: '700' },
  button: {
    minHeight: theme.tap,
    borderRadius: theme.radius,
    backgroundColor: theme.green,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonPressed: { backgroundColor: theme.greenDeep },
  buttonText: { color: '#fff', fontSize: 18, fontWeight: '700' },
  quiet: { backgroundColor: 'transparent' },
  quietText: { color: theme.green, fontSize: 16, fontWeight: '600' },
  error: {
    backgroundColor: '#fdecea',
    borderLeftWidth: 4,
    borderLeftColor: theme.danger,
    borderRadius: 6,
    padding: 12,
  },
  errorText: { color: theme.danger, fontSize: 15, lineHeight: 21 },
  card: {
    backgroundColor: theme.paper,
    borderRadius: theme.radius,
    borderWidth: 1,
    borderColor: theme.line,
    padding: 16,
    gap: 4,
  },
  cardTitle: { fontSize: 19, fontWeight: '700', color: theme.ink },
  meta: { fontSize: 15, color: theme.inkSoft },
});

function Button(props: { label: string; onPress: () => void; busy?: boolean; quiet?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.busy === true}
      onPress={props.onPress}
      style={({ pressed }) => [
        s.button,
        props.quiet === true && s.quiet,
        pressed && props.quiet !== true && s.buttonPressed,
        props.busy === true && { opacity: 0.6 },
      ]}
    >
      {props.busy === true ? (
        <ActivityIndicator color={props.quiet === true ? theme.green : '#fff'} />
      ) : (
        <Text style={props.quiet === true ? s.quietText : s.buttonText}>{props.label}</Text>
      )}
    </Pressable>
  );
}

function Problem({ message }: { message: string | null }) {
  if (message === null) return null;
  return (
    <View style={s.error}>
      <Text style={s.errorText}>{message}</Text>
    </View>
  );
}

export function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setProblem(null);
    try {
      await api.signIn(email.trim(), password);
      onSignedIn();
    } catch (error) {
      setProblem(error instanceof ApiError ? error.message : 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad} keyboardShouldPersistTaps="handled">
      <Text style={s.title}>Divot Diggers</Text>
      <Text style={s.lede}>Sign in with the account you set up in the console.</Text>
      <Problem message={problem} />
      <View>
        <Text style={s.label}>Email</Text>
        <TextInput
          style={s.input}
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          inputMode="email"
          placeholder="you@example.com"
        />
      </View>
      <View>
        <Text style={s.label}>Password</Text>
        <TextInput
          style={s.input}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoComplete="current-password"
        />
      </View>
      <Button label="Sign in" onPress={() => void submit()} busy={busy} />
    </ScrollView>
  );
}

export function Join({ onJoined, onSignOut }: { onJoined: () => void; onSignOut: () => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setProblem(null);
    try {
      await api.join(code);
      onJoined();
    } catch (error) {
      setProblem(error instanceof ApiError ? error.message : 'Could not join.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad} keyboardShouldPersistTaps="handled">
      <Text style={s.title}>Join the trip</Text>
      <Text style={s.lede}>
        Enter the six-character code from whoever is running the group. You only need to do
        this once.
      </Text>
      <Problem message={problem} />
      <TextInput
        style={[s.input, s.codeInput]}
        value={code}
        onChangeText={(next) => setCode(next.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))}
        autoCapitalize="characters"
        autoCorrect={false}
        maxLength={6}
        placeholder="ABC234"
      />
      <Button label="Join" onPress={() => void submit()} busy={busy} />
      <Button label="Sign out" quiet onPress={onSignOut} />
    </ScrollView>
  );
}

export function Home({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Text style={s.title}>{me.displayName}</Text>
      <Text style={s.lede}>
        You are in. Scoring arrives in the next build — this is the shell it hangs off.
      </Text>
      {me.events.map((event) => (
        <View key={event.eventId} style={s.card}>
          <Text style={s.cardTitle}>{event.eventName}</Text>
          <Text style={s.meta}>{event.roles.join(', ')}</Text>
        </View>
      ))}
      <Button label="Sign out" quiet onPress={onSignOut} />
    </ScrollView>
  );
}
