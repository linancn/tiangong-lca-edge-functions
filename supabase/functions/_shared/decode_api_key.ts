export interface Credentials {
  email: string;
  password: string;
}

function decodeApiKey(apiKey: string): Credentials | null {
  if (!apiKey) return null;

  try {
    const jsonString = atob(apiKey);
    const parsed: unknown = JSON.parse(jsonString);

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const email = Reflect.get(parsed, 'email');
    const password = Reflect.get(parsed, 'password');
    if (typeof email !== 'string' || !email || typeof password !== 'string' || !password) {
      return null;
    }

    return { email, password };
  } catch (_error) {
    return null;
  }
}

export default decodeApiKey;
