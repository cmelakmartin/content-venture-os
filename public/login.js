const form = document.querySelector("#login-form");
const message = document.querySelector("#login-message");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  message.textContent = "";
  const values = Object.fromEntries(new FormData(form));
  try {
    const response = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(values) });
    const raw = await response.text();
    let result;
    try { result = raw ? JSON.parse(raw) : {}; }
    catch { throw new Error(`The service is temporarily unavailable (${response.status}). Please retry.`); }
    if (!response.ok) throw new Error(result.error || "Sign-in failed.");
    location.replace("/");
  } catch (error) {
    message.textContent = error.message;
    message.className = "error";
    button.disabled = false;
  }
});
