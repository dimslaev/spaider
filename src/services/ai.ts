import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import {
  Intent,
  FileContext,
  Change,
  Changes,
  RelevantFilePaths,
  ChangeOverview,
  ChangeOverviews,
} from "../lib/types";
import {
  IntentSchema,
  ChangesSchema,
  RelevantFilePathsSchema,
  ChangeOverviewsSchema,
} from "../lib/schemas";
import {
  system,
  user,
  formatFilePreviews,
  formatFileSemantics,
  formatChanges,
} from "../lib/utils";
import { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import { RequestOptions } from "openai/core";
import { Logger } from "./logger";

const DEFAULT_SYSTEM_ROLE =
  "You are an AI assistant specialized in software development and code generation.";

export namespace AI {
  const openai = new OpenAI({
    baseURL: process.env.OPENAI_BASE_URL || "",
    apiKey: process.env.OPENAI_API_KEY || "no-key",
  });

  export async function complete(
    body: Partial<ChatCompletionCreateParamsNonStreaming>,
    options?: RequestOptions
  ) {
    if (!body.messages) {
      throw new Error("No messages for complete request");
    }

    const {
      model = process.env.OPENAI_MODEL || "gpt-4.1",
      temperature = 0,
      max_completion_tokens = 8000,
      messages,
      ...rest
    } = body;

    const response = await openai.chat.completions.create(
      {
        model,
        temperature,
        max_completion_tokens,
        messages,
        ...rest,
      },
      {
        maxRetries: 2,
        timeout: 30_000,
        ...options,
      }
    );

    return response;
  }

  export async function completeStructured<T>(params: {
    role?: string;
    user: string;
    schema: z.Schema;
    name: string;
  }): Promise<T> {
    const messages = [
      system(
        `${params.role || DEFAULT_SYSTEM_ROLE}
You must respond with valid JSON that matches the provided schema. 
Do not include any text outside the JSON response. 
Do not wrap the JSON in markdown code blocks or use \`\`\` formatting.`
      ),
      user(params.user),
    ];

    const response = await complete({
      messages,
      response_format: zodResponseFormat(params.schema, params.name),
    });

    const content = response.choices[0].message.content!;

    // Remove any potential markdown code block markers that might have been added
    const cleanContent = content
      .replace(/^```[\w]*\n?/, "")
      .replace(/\n?```$/, "");

    try {
      const parsed = JSON.parse(cleanContent);
      return params.schema.parse(parsed);
    } catch (error) {
      Logger.error("=== JSON PARSING ERROR ===");
      Logger.error("Full response content:");
      Logger.error(cleanContent);
      Logger.error("========================");
      Logger.error("Error:", error);

      // If JSON parse fails, try to identify common issues
      if (error instanceof SyntaxError) {
        Logger.error("JSON Syntax Error detected. Common issues:");
        if (cleanContent.includes("`")) {
          Logger.error("- Contains backticks (`) which are not valid in JSON");
        }
        if (cleanContent.includes("\n") && !cleanContent.includes("\\n")) {
          Logger.error("- Contains unescaped newlines");
        }
        if (cleanContent.match(/[^\\]"/)) {
          Logger.error("- Contains unescaped quotes");
        }
      }

      throw error;
    }
  }

  export async function analyzeIntent(
    userPrompt: string,
    files: FileContext[],
    _projectTree?: string
  ): Promise<Intent> {
    const filePreview = formatFilePreviews(files);
    const semanticSummary = formatFileSemantics(files);

    const prompt = `
Analyze this code related request to understand the user intent.

User Request: ${userPrompt}

Files provided:
${filePreview}

Code Symbols:
${semanticSummary}

Based on this information, determine:
1. Should files be changed to fulfill the user's request? Set editMode to true if the user is asking for any code be created or modified. Set editMode to false if the user is only asking for information, explanation, or code review. If the request is ambiguous, prefer false unless there is a clear instruction to change files.
2. A clear description of what needs to be done (be specific about the scope and impact)
3. Whether additional context is needed to proceed - set needsMoreContext to true if additional files or information are needed
4. List of file paths relevant to this intent (filePaths)
5. List of the most relevant search terms (searchTerms) from the "Code Symbols" section. Include EXLUSIVELY only terms which are relevant to the "User Request", sorted in terms of relevance in descending order.
    `;

    Logger.info("prompt");
    Logger.info("");
    Logger.info(prompt);

    const res = await completeStructured<Intent>({
      user: prompt,
      schema: IntentSchema,
      name: "intent",
    });

    Logger.info("searchTerms");
    Logger.info("");
    Logger.info(res.searchTerms.join(", "));

    return res;
  }

  export async function prepareChanges(
    intent: Intent,
    files: FileContext[]
  ): Promise<ChangeOverview[]> {
    const filePreview = formatFilePreviews(files, true);

    const prompt = `
${intent.description}

Files provided:
${filePreview}

Based on the user's request and the provided files, determine what changes need to be made to each file. For each file that needs changes, provide:

1. filePath: The path to the file
2. overview: A clear overview of the changes that need to be done to this file
3. operation: The type of operation (new_file, delete_file, or modify_file)

Focus on providing high-level overviews of what needs to be accomplished for each file, not the specific code changes. This is a planning step.
`;

    const response = await completeStructured<ChangeOverviews>({
      role: `You are a software architect planning code changes. Provide clear overviews of the changes that need to be done to each file`,
      user: prompt,
      schema: ChangeOverviewsSchema,
      name: "change-overviews",
    });

    return response.overviews;
  }

  export async function generateChangesForFile(
    intent: Intent,
    file: FileContext,
    fileDescription: string
  ): Promise<Change[]> {
    const filePreview = formatFilePreviews([file], true);

    const prompt = `
${intent.description}

File-specific task: ${fileDescription}

File: ${file.path}
${filePreview}

Based on this specific file and the description of what needs to be done, generate precise code changes for this file only.

Generate a JSON response with a "changes" array containing change objects. Each change object should have:
1. operation: [new_file, delete_file, modify_file]
2. filePath: The path to the file being created, deleted or modified
3. modificationType: [replace_block, add_block, remove_block, none]. For deleted files, use type none.
4. modificationDescription: The description of the modification relative to the code blocks. Leave empty if not applicable.
5. oldCodeBlock: Applicable when modifying existing files. Leave empty if not applicable.
6. newCodeBlock: Applicable when modifying existing files or creating new ones. Leave empty if not applicable.

Focus on generating precise changes for this specific file while maintaining high code quality.
For modifications, generate multiple changes per file if necessary.

CRITICAL: Return ONLY valid JSON. Do not use backticks, template literals, or multi-line strings.
Escape all quotes and newlines properly in JSON strings.

Use \\n for newlines within strings, not actual line breaks.
Use \" for quotes within strings.

Return the response in this exact format:
{
  "changes": [
    {
      "operation": "modify_file",
      "filePath": "${file.path}",
      "modificationType": "add_block",
      "modificationDescription": "Description of change",
      "oldCodeBlock": "",
      "newCodeBlock": "// New code here\\nfunction example() {\\n  return true;\\n}"
    }
  ]
}
`;

    const result = await completeStructured<Changes>({
      role: "You are a senior software engineer generating precise code changes for a specific file. Generate high-quality, production-ready code changes to implement the following request",
      user: prompt,
      schema: ChangesSchema,
      name: "changes",
    });

    return result.changes;
  }

  export async function generateChanges(
    intent: Intent,
    files: FileContext[]
  ): Promise<Change[]> {
    const filePreview = formatFilePreviews(files, true);

    const prompt = `
      ${intent.description}

      Files provided:
      ${filePreview}
      
      Based on this information, generate a JSON response with a "changes" array containing change objects. Each change object should have:
      1. operation: [new_file, delete_file, modify_file]
      2. filePath: The path to the file being created, deleted or modified
      3. modificationType: [replace_block, add_block, remove_block, none]. For deleted files, use type none.
      4. modificationDescription: The description of the modification relative to the code blocks. Leave empty if not applicable.
      5. oldCodeBlock: Applicable when modifying existing files. Leave empty if not applicable.
      6. newCodeBlock: Applicable when modifying existing files or creating new ones. Leave empty if not applicable.
      
      Focus on generating precise changes aligned with existing code structure while maintaining high code quality. 
      For modifications, generate multiple changes per file if necessary.
      
      CRITICAL: Return ONLY valid JSON. Do not use backticks, template literals, or multi-line strings. 
      Escape all quotes and newlines properly in JSON strings.
      
      Use \\n for newlines within strings, not actual line breaks.
      Use \" for quotes within strings.
      
      Return the response in this exact format:
      {
        "changes": [
          {
            "operation": "modify_file",
            "filePath": "path/to/file.ts",
            "modificationType": "add_block",
            "modificationDescription": "Description of change",
            "oldCodeBlock": "",
            "newCodeBlock": "// New code here\\nfunction example() {\\n  return true;\\n}"
          }
        ]
      }
    `;

    const result = await completeStructured<Changes>({
      role: "You are a senior software engineer generating precise code changes. Generate high-quality, production-ready code changes to implement the following request",
      user: prompt,
      schema: ChangesSchema,
      name: "changes",
    });

    return result.changes;
  }

  export async function applyFileChanges(
    changes: Change[],
    currentFileContent: string
  ): Promise<string> {
    const formattedChanges = formatChanges(changes);

    if (changes[0].operation === "delete_file") {
      throw new Error("AI should not handle delete operations");
    }

    const header =
      changes[0].operation === "new_file"
        ? "Create a new file with the requested code blocks."
        : "Apply ONLY the specified modifications to this existing file.";

    const prompt = `
      ${header}

      Current File Content:
      \`\`\`
      ${currentFileContent}
      \`\`\`

      Modifications to Apply:
      ${formattedChanges}

      Instructions:
      1. Start with the exact current file content shown above
      2. Apply ONLY the specified modifications - do not change anything else
      3. For replace_block: find the exact old code block and replace it with the new code block
      4. For add_block: insert the new code block at the appropriate location
      5. For remove_block: remove only the specified code block
      6. Maintain ALL existing formatting, imports, exports, and other code exactly as they are
      7. Return the complete modified file content
      8. Do not add explanations, comments, or markdown formatting

      Apply the modifications precisely and return the complete file.
    `;

    const response = await complete({
      messages: [
        system(
          `${DEFAULT_SYSTEM_ROLE}
Return only the complete rewritten file content without any additional formatting or explanation.`
        ),
        user(prompt),
      ],
    });

    const rewrittenContent = response.choices[0].message.content!.trim();

    // Remove any potential markdown code block markers that might have been added
    return rewrittenContent.replace(/^```[\w]*\n?/, "").replace(/\n?```$/, "");
  }

  export async function generateAnswer(
    intent: Intent,
    files: FileContext[]
  ): Promise<string> {
    const filePreview = formatFilePreviews(files, true);

    const prompt = `
${intent.description}

Files analyzed:
${filePreview}
    `;

    const response = await complete({
      messages: [
        system(`${DEFAULT_SYSTEM_ROLE}
For code-related prompts, prioritize code output with minimal explanation.
For refactoring requests, provide the refactored code and a very short summary of changes.
Always deliver clear, concise and efficient answers.`),
        user(prompt),
      ],
    });

    return response.choices[0].message.content!.trim();
  }

  export async function filterRelevantFilePaths(
    intent: Intent,
    discoveredFilePaths: string[]
  ): Promise<RelevantFilePaths["filePaths"]> {
    if (discoveredFilePaths.length === 0) {
      return [];
    }

    const prompt = `
Based on the user intent, determine which of these file paths might be relevant to the task.

Intent: ${intent.description}

File paths (need to filter for relevance):
${discoveredFilePaths}

Return a list of file paths sorted by relevance to the intent in descending order. Exlude paths that are unlikely to contain information that can help achieve the task.
`;

    const response = await completeStructured<RelevantFilePaths>({
      user: prompt,
      schema: RelevantFilePathsSchema,
      name: "relevant-file-paths",
    });

    return response.filePaths;
  }

  export async function extractRelevantCodeBlocks(
    intent: Intent,
    file: FileContext
  ): Promise<string | null> {
    if (!file.content) {
      return null;
    }

    const prompt = `
Extract only the most relevant code blocks from this file based on the user's request and intent.

Intent: ${intent.description}
Search Terms: ${intent.searchTerms.join(", ")}

File: ${file.path}
Content:
\`\`\`
${file.content}
\`\`\`

Instructions:
1. Identify code blocks (functions, classes, imports, exports, etc.) that are most relevant to the user's request
2. Extract only the relevant code blocks, maintaining their original structure and formatting
3. Include necessary imports and dependencies for the extracted code to be meaningful
4. If no code is relevant to the request, return null
5. Return only the extracted code blocks, not the entire file
6. Preserve the original indentation and formatting

Return the extracted relevant code blocks or null if nothing is relevant.
`;

    const response = await complete({
      messages: [
        system(`${DEFAULT_SYSTEM_ROLE}
You are a code analysis expert. Extract only the most relevant code blocks from files based on user requests.
Return only the extracted code blocks without any explanations or markdown formatting.`),
        user(prompt),
      ],
    });

    const extractedContent = response.choices[0].message.content!.trim();

    // Remove any potential markdown code block markers
    const cleanContent = extractedContent
      .replace(/^```[\w]*\n?/, "")
      .replace(/\n?```$/, "")
      .trim();

    // Return null if the AI indicates no relevant content or if the content is empty
    if (
      !cleanContent ||
      cleanContent.toLowerCase().includes("no relevant") ||
      cleanContent.toLowerCase().includes("null")
    ) {
      return null;
    }

    return cleanContent;
  }
}
