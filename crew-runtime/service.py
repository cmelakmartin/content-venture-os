from __future__ import annotations

import json
import os
import secrets
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Literal

from crewai import Agent, Crew, Process, Task
from pydantic import BaseModel, Field, ValidationError


class FunnelPatch(BaseModel):
    headline: str | None = None
    subheadline: str | None = None


class VenturePackage(BaseModel):
    productSummary: str
    audience: str
    problem: str
    promise: str
    offerName: str
    priceHypothesisEur: float
    headline: str
    subheadline: str
    benefits: list[str] = Field(min_length=3, max_length=6)
    leadMagnet: str
    welcomeEmailSubject: str
    welcomeEmailBody: str
    rightsAndClaimsFlags: list[str]
    firstExperiment: str


class Recommendation(BaseModel):
    observation: str
    proposedChange: str
    targetMetric: str
    evidence: list[str]
    confidence: Literal["low", "medium", "high"]
    requiresApproval: Literal[True]
    funnelPatch: FunnelPatch


def model_name() -> str:
    return os.getenv("CREWAI_MODEL", "openai/gpt-5-mini")


def require_model_key() -> None:
    if not os.getenv("OPENAI_API_KEY"):
        raise RuntimeError("OPENAI_API_KEY is not configured in the CrewAI runtime.")


def agent(role: str, goal: str, backstory: str) -> Agent:
    return Agent(
        role=role,
        goal=goal,
        backstory=backstory,
        llm=model_name(),
        allow_delegation=False,
        verbose=False,
        max_iter=6,
    )


def normalize(value: Any) -> Any:
    if value is None:
        return None
    if hasattr(value, "model_dump"):
        return value.model_dump()
    if hasattr(value, "dict"):
        return value.dict()
    if isinstance(value, dict):
        return value
    return str(value)


def crew_result(crew: Crew, result: Any, output_type: type[BaseModel], roles: list[str]) -> dict[str, Any]:
    structured = result.pydantic if getattr(result, "pydantic", None) is not None else output_type.model_validate(result.to_dict())
    return {
        "provider": "crewai",
        "model": model_name(),
        "output": structured.model_dump(),
        "trace": {
            "process": "sequential",
            "roles": roles,
            "taskCount": len(crew.tasks),
            "usage": normalize(getattr(crew, "usage_metrics", None)),
        },
    }


def analyze_product(payload: dict[str, Any]) -> dict[str, Any]:
    require_model_key()
    product_text = str(payload.get("productText", "")).strip()
    metadata = payload.get("metadata") or {}
    if len(product_text) < 40:
        raise ValueError("Extracted product text is too short for a CrewAI analysis.")
    if len(product_text) > 300_000:
        raise ValueError("Extracted product text exceeds the CrewAI PoC limit.")

    analyst = agent(
        "Product Analyst",
        "Identify what the supplied product genuinely teaches, its most credible audience, and its practical outcome.",
        "You are a skeptical digital-product analyst. You distinguish source evidence from marketing inference and never invent capabilities.",
    )
    rights = agent(
        "Rights and Claims Reviewer",
        "Identify resale-rights, unsupported-claim, legal-promise, and human-review risks conservatively.",
        "You protect the owner from overclaiming and from distributing source material beyond the stated licence.",
    )
    architect = agent(
        "Venture Architect",
        "Design one narrow EUR-priced validation offer, landing page, lead magnet, welcome email, and measurable first experiment.",
        "You convert evidence into a practical low-hype venture package. You do not claim deployment or guaranteed outcomes.",
    )

    analyst_task = Task(
        description=f"Analyze this product. Filename: {metadata.get('name', 'uploaded product')}.\n\nPRODUCT CONTENT:\n{product_text}",
        expected_output="An evidence-grounded product summary, audience, problem, outcome, and uncertainties.",
        agent=analyst,
    )
    rights_task = Task(
        description=f"Review the product and analysis for rights and claims risk. Source-rights note: {metadata.get('sourceRights', 'Customer asserts ownership or a suitable licence.')}",
        expected_output="A conservative list of rights, claims, legal, and human-review flags.",
        agent=rights,
        context=[analyst_task],
    )
    package_task = Task(
        description="Reconcile the product analysis and rights review into one narrow validation package. Keep all claims supportable and express price in EUR.",
        expected_output="A complete schema-valid venture package with 3–6 benefits and one measurable first experiment.",
        agent=architect,
        context=[analyst_task, rights_task],
        output_pydantic=VenturePackage,
    )
    crew = Crew(
        agents=[analyst, rights, architect],
        tasks=[analyst_task, rights_task, package_task],
        process=Process.sequential,
        verbose=False,
        memory=False,
        cache=False,
        planning=False,
    )
    return crew_result(crew, crew.kickoff(), VenturePackage, ["Product Analyst", "Rights and Claims Reviewer", "Venture Architect"])


def optimize(payload: dict[str, Any]) -> dict[str, Any]:
    require_model_key()
    metrics = payload.get("metrics")
    if not isinstance(metrics, dict):
        raise ValueError("Observed metrics are required.")
    optimizer = agent(
        "Evidence-bound Venture Optimizer",
        "Recommend exactly one reversible landing-page improvement using only observed metrics.",
        "You never invent conversions, revenue, causality, or attribution. Every change remains subject to explicit owner approval.",
    )
    task = Task(
        description=f"Analyze only these observed metrics and propose one exact headline and/or subheadline patch. Always set requiresApproval to true.\n\nMETRICS:\n{json.dumps(metrics, default=str)}",
        expected_output="One schema-valid, reversible recommendation with evidence, confidence, target metric, and exact funnel patch.",
        agent=optimizer,
        output_pydantic=Recommendation,
    )
    crew = Crew(agents=[optimizer], tasks=[task], process=Process.sequential, verbose=False, memory=False, cache=False, planning=False)
    return crew_result(crew, crew.kickoff(), Recommendation, ["Evidence-bound Venture Optimizer"])


class Handler(BaseHTTPRequestHandler):
    server_version = "ContentVentureCrewAI/1.0"

    def send_json(self, status: int, body: dict[str, Any]) -> None:
        encoded = json.dumps(body, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def authorized(self) -> bool:
        secret = os.getenv("CREWAI_SHARED_SECRET", "")
        supplied = self.headers.get("authorization", "").removeprefix("Bearer ")
        return len(secret) >= 24 and secrets.compare_digest(secret, supplied)

    def do_GET(self) -> None:
        if self.path != "/health":
            return self.send_json(404, {"error": "Not found"})
        self.send_json(200, {"status": "ready", "provider": "crewai", "model": model_name(), "modelConfigured": bool(os.getenv("OPENAI_API_KEY"))})

    def do_POST(self) -> None:
        if not self.authorized():
            return self.send_json(401, {"error": "Invalid CrewAI service authorization."})
        try:
            length = int(self.headers.get("content-length", "0"))
            if length <= 0 or length > 2_000_000:
                raise ValueError("Request body size is invalid.")
            payload = json.loads(self.rfile.read(length))
            if self.path == "/v1/analyze-product":
                result = analyze_product(payload)
            elif self.path == "/v1/optimize":
                result = optimize(payload)
            else:
                return self.send_json(404, {"error": "Not found"})
            self.send_json(200, result)
        except (ValueError, ValidationError, RuntimeError) as error:
            self.send_json(400, {"error": str(error)})
        except Exception as error:
            self.send_json(500, {"error": f"CrewAI execution failed: {error}"})

    def log_message(self, format: str, *args: Any) -> None:
        print(f"crew-runtime {self.address_string()} {format % args}", flush=True)


if __name__ == "__main__":
    port = int(os.getenv("PORT", "8000"))
    print(f"CrewAI runtime listening on 0.0.0.0:{port} with {model_name()}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
