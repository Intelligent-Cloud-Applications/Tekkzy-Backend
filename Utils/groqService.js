const axios = require("axios");

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

const SYSTEM_PROMPT = `You are a senior code reviewer. Analyze git changes and respond with ONLY valid JSON (no markdown) using this schema:
{
  "authorSummaries": [
    {
      "author": "author name",
      "email": "author email if available",
      "summary": "concise summary of what this author changed",
      "filesChanged": ["file paths"]
    }
  ],
  "securityIssues": [
    {
      "severity": "low|medium|high|critical",
      "title": "short title",
      "description": "what the issue is",
      "file": "affected file or null",
      "recommendation": "how to fix it"
    }
  ],
  "overallSummary": "one paragraph overview of the entire changeset"
}

Group changes by author. Flag secrets, auth bypasses, injection risks, insecure dependencies, and overly permissive IAM/CORS. If no security issues, return an empty securityIssues array.`;

async function analyzeChanges({ commits, diff, files }) {
  const apiKey = process.env.GROQ_API_KEY;
  const model = process.env.GROQ_MODEL || "llama-3.1-8b-instant";

  if (!apiKey) {
    throw new Error("GROQ_API_KEY is not set");
  }

  const payload = {
    commits: commits || [],
    files: files || [],
    diff: typeof diff === "string" ? diff.slice(0, 50000) : "",
  };

  const response = await axios.post(
    GROQ_API_URL,
    {
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify(payload) },
      ],
      temperature: 0.2,
      response_format: { type: "json_object" },
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      timeout: 60000,
    }
  );

  const content = response.data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Groq returned an empty response");
  }

  return JSON.parse(content);
}

module.exports = { analyzeChanges };
