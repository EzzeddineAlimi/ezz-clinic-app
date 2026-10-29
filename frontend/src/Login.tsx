import { useState } from "react";
import type { FormEvent } from "react";
import { Api } from "./api.ts";
import type { Lang, Words } from "./i18n.ts";
import { Brand, ErrorBox, Icon, Language } from "./ui.tsx";
export function Login({
  w,
  lang,
  setLang,
  notice,
  authenticated,
}: {
  w: Words;
  lang: Lang;
  setLang: (lang: Lang) => void;
  notice: string;
  authenticated: (token: string, clinicCode: string) => Promise<void>;
}) {
  const [pending, setPending] = useState(false),
    [error, setError] = useState<unknown>();
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setPending(true);
    setError(undefined);
    try {
      const clinicCode = String(f.get("clinicCode")).trim();
      const r = await new Api().login({
        clinicCode,
        username: String(f.get("username")).trim(),
        password: String(f.get("password")),
      });
      await authenticated(r.token, clinicCode);
    } catch (err) {
      setError(err);
    } finally {
      setPending(false);
    }
  }
  return (
    <main className="login-layout">
      <section className="login-aside">
        <Brand />
        <div>
          <div className="orbit">
            <span />
            <span />
            <span />
          </div>
          <h1>
            {w.welcomeAside.split("\n").map((line, i) => (
              <span key={i}>
                {line}
                <br />
              </span>
            ))}
          </h1>
          <p>{w.asideText}</p>
        </div>
        <span className="aside-foot">EZZ CLINIC · TUNISIE</span>
      </section>
      <section className="login-main">
        <Language lang={lang} setLang={setLang} w={w} />
        <div className="login-card">
          <div className="mobile-brand">
            <Brand />
          </div>
          <p className="eyebrow">{w.reception}</p>
          <h2>{w.loginTitle}</h2>
          <p className="muted">{w.loginIntro}</p>
          {notice && (
            <div className="warning" role="status">
              {notice}
            </div>
          )}
          {error !== undefined && <ErrorBox error={error} w={w} />}
          <form onSubmit={(e) => void submit(e)}>
            <fieldset disabled={pending}>
              <label>
                {w.clinic}
                <input
                  name="clinicCode"
                  required
                  maxLength={40}
                  autoComplete="organization"
                  spellCheck={false}
                />
              </label>
              <label>
                {w.username}
                <input
                  name="username"
                  required
                  maxLength={40}
                  autoComplete="username"
                  spellCheck={false}
                />
              </label>
              <label>
                {w.password}
                <input
                  name="password"
                  type="password"
                  required
                  maxLength={128}
                  autoComplete="current-password"
                />
              </label>
            </fieldset>
            <button className="primary full" disabled={pending}>
              {pending ? w.loginBusy : w.login}
              <Icon name="arrow" />
            </button>
          </form>
          <p className="login-note">{w.loginNote}</p>
          <p className="demo-note">{w.loginHint}</p>
        </div>
      </section>
    </main>
  );
}
