const REQUIRED = {
  consumerKey: "CONSUMER_KEY",
  consumerSecret: "CONSUMER_SECRET",
  clientId: "CLIENT_ID",
  clientPassword: "CLIENT_PASSWORD",
  jwtSecret: "JWT_SECRET",
};

export function configFromEnv(env = process.env) {
  const config = { missing: [] };
  for (const [field, name] of Object.entries(REQUIRED)) {
    if (env[name]) {
      config[field] = env[name];
    } else {
      config.missing.push(name);
    }
  }
  return config;
}
