// Setup type definitions for built-in Supabase Runtime APIs
import "@supabase/functions-js/edge-runtime.d.ts";

import { authenticateRequest, AuthMethod } from "../_shared/auth.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { supabaseClient } from "../_shared/supabase_client.ts";

interface WebhookPayload {
  type: "INSERT" | "UPDATE" | "DELETE";
  table: string;
  schema: string;
  record: Record<string, unknown> | null;
  old_record: Record<string, unknown> | null;
}

const DEFAULT_LANG = "en";

const isObject = (value: unknown): value is Record<string, any> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const pickProperty = (obj: any, names: string[]) => {
  if (!obj || typeof obj !== "object") return undefined;
  for (const name of names) {
    const value = (obj as any)[name];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
};

const ensureArray = <T>(obj: T | T[] | null | undefined): T[] => {
  if (obj === null || obj === undefined) return [];
  return Array.isArray(obj) ? obj : [obj];
};

const getTextFromDict = (data: any): string | null => {
  if (data === null || data === undefined) return null;
  if (typeof data === "string" || typeof data === "number") {
    const text = String(data).trim();
    return text || null;
  }
  if (isObject(data)) {
    const text = data["#text"] ?? data["text"] ?? data["_text"];
    if (typeof text === "string") {
      const trimmed = text.trim();
      return trimmed || null;
    }
  }
  return null;
};

const getLangText = (value: any, lang = DEFAULT_LANG): string | null => {
  if (value === null || value === undefined) return null;

  if (typeof value === "string" || typeof value === "number") {
    const text = String(value).trim();
    return text || null;
  }

  if (Array.isArray(value)) {
    const exact = value.find(
      (item) =>
        isObject(item) && item["@xml:lang"] && item["@xml:lang"] === lang,
    );
    if (exact !== undefined) {
      const text = getLangText(exact, lang);
      if (text) return text;
    }
    for (const item of value) {
      const text = getLangText(item, lang);
      if (text) return text;
    }
    return null;
  }

  if (isObject(value)) {
    if (typeof (value as any).get_text === "function") {
      const text = (value as any).get_text(lang);
      if (text) {
        const trimmed = String(text).trim();
        if (trimmed) return trimmed;
      }
    }
    const text = getTextFromDict(value);
    if (text) return text;
    for (const key of Object.keys(value)) {
      if (key.toLowerCase().includes("text")) {
        const nestedText = getLangText((value as any)[key], lang);
        if (nestedText) return nestedText;
      }
    }
  }

  return null;
};

const toDisplayText = (value: any, lang = DEFAULT_LANG): string | null => {
  if (value === null || value === undefined) return null;
  if (
    typeof value === "string" || typeof value === "number" ||
    typeof value === "boolean"
  ) {
    const text = String(value).trim();
    return text || null;
  }
  return getLangText(value, lang) ?? getTextFromDict(value);
};

const findProcessDataSet = (data: any): any => {
  if (!isObject(data)) return null;

  const direct = pickProperty(data, ["processDataSet", "process_data_set"]) ??
    pickProperty(data, ["processdataset", "process_dataset"]);
  if (direct) return direct;

  if (pickProperty(data, ["processInformation", "process_information"])) {
    return data;
  }

  for (const key of Object.keys(data)) {
    const value = (data as any)[key];
    if (isObject(value)) {
      const found = findProcessDataSet(value);
      if (found) return found;
    }
  }

  return null;
};

const getFlowName = (
  referenceToFlow: Record<string, any> | undefined,
  lang = DEFAULT_LANG,
) => {
  if (!referenceToFlow) return null;
  const shortDesc = pickProperty(referenceToFlow, [
    "common:shortDescription",
    "shortDescription",
    "common:short_description",
    "common:shortdescription",
  ]);
  return getLangText(shortDesc, lang);
};

const getReferenceFlow = (
  processDataSet: any,
  refFlowId: string | null,
  lang = DEFAULT_LANG,
): { name: string | null; direction: any; amount: any; uuid: any } | null => {
  if (!refFlowId) return null;

  const exchangesObj = pickProperty(processDataSet, ["exchanges"]);
  const exchangeList = ensureArray(
    pickProperty(exchangesObj, ["exchange"]) ?? exchangesObj,
  );
  if (!exchangeList.length) return null;

  for (const ex of exchangeList) {
    const exId = pickProperty(ex, [
      "dataSetInternalID",
      "data_set_internal_id",
      "@dataSetInternalID",
      "@data_set_internal_id",
    ]);
    if (
      exId !== undefined && exId !== null && String(exId) === String(refFlowId)
    ) {
      const reference = pickProperty(ex, [
        "referenceToFlowDataSet",
        "reference_to_flow_data_set",
      ]);
      return {
        name: getFlowName(reference, lang),
        direction: pickProperty(ex, [
          "exchangeDirection",
          "exchange_direction",
        ]),
        amount: pickProperty(ex, [
          "meanAmount",
          "mean_amount",
          "resultingAmount",
          "resulting_amount",
        ]),
        uuid: reference
          ? pickProperty(reference, [
            "@refObjectId",
            "@refObjectID",
            "refObjectId",
            "refObjectID",
          ])
          : null,
      };
    }
  }

  return null;
};

const tidasProcessToMarkdown = (processJson: any, lang = DEFAULT_LANG) => {
  const processDataSet = findProcessDataSet(processJson);
  if (!processDataSet) {
    throw new Error("Invalid process JSON: missing process data set");
  }

  const processInformation = pickProperty(processDataSet, [
    "processInformation",
    "process_information",
  ]) ?? {};
  const dataSetInformation = pickProperty(processInformation, [
    "dataSetInformation",
    "data_set_information",
  ]) ?? {};

  const sections: string[] = [];

  const nameObj = pickProperty(dataSetInformation, ["name"]);
  const baseNameValue = nameObj
    ? pickProperty(nameObj, ["baseName", "base_name", "basename"])
    : undefined;
  const baseName = getLangText(baseNameValue ?? nameObj, lang);
  if (baseName) {
    sections.push(`# ${baseName}`);
  }

  const uuid = pickProperty(dataSetInformation, [
    "common:UUID",
    "common_uuid",
    "uuid",
    "UUID",
  ]) ??
    pickProperty(dataSetInformation, ["common:uuid"]);
  const uuidText = toDisplayText(uuid, lang);
  if (uuidText) {
    sections.push(`**UUID:** \`${uuidText}\``);
  }

  const quantitativeReference = pickProperty(processInformation, [
    "quantitativeReference",
    "quantitative_reference",
  ]);
  const refFlowId = quantitativeReference
    ? pickProperty(quantitativeReference, [
      "referenceToReferenceFlow",
      "reference_to_reference_flow",
      "@ref",
    ])
    : null;
  const refFlow = getReferenceFlow(
    processDataSet,
    refFlowId ? String(refFlowId) : null,
    lang,
  );
  if (refFlow && refFlow.name) {
    const refParts = [`**Reference Flow:** ${refFlow.name}`];
    const amountText = toDisplayText(refFlow.amount, lang);
    if (amountText) {
      refParts.push(`**Amount:** ${amountText}`);
    }
    sections.push(refParts.join("\n"));
  }

  const classificationInformation = pickProperty(dataSetInformation, [
    "classificationInformation",
    "classification_information",
  ]);
  const commonClassification = classificationInformation
    ? pickProperty(classificationInformation, [
      "common:classification",
      "classification",
      "common_classification",
    ])
    : undefined;
  const classData = commonClassification
    ? pickProperty(commonClassification, [
      "common:class",
      "class",
      "common_class",
    ])
    : undefined;
  const classText = classData ? getLangText(classData, lang) : null;
  if (classText) {
    sections.push(`**Classification:** ${classText}`);
  }

  const generalComment = getLangText(
    pickProperty(dataSetInformation, [
      "common:generalComment",
      "common_general_comment",
      "generalComment",
      "general_comment",
    ]),
    lang,
  );
  if (generalComment) {
    const comment = generalComment.length > 500
      ? `${generalComment.slice(0, 500)}...`
      : generalComment;
    sections.push(`## Description\n\n${comment}`);
  }

  const timeInfo = pickProperty(processInformation, ["time"]);
  if (timeInfo) {
    const timeParts: string[] = [];
    const referenceYear = toDisplayText(
      pickProperty(timeInfo, [
        "common:referenceYear",
        "common_reference_year",
        "referenceYear",
        "reference_year",
      ]),
      lang,
    );
    const validUntil = toDisplayText(
      pickProperty(timeInfo, [
        "common:dataSetValidUntil",
        "common_data_set_valid_until",
        "dataSetValidUntil",
        "validUntil",
        "valid_until",
      ]),
      lang,
    );

    if (referenceYear) timeParts.push(`Reference Year: ${referenceYear}`);
    if (validUntil) timeParts.push(`Valid Until: ${validUntil}`);
    if (timeParts.length) {
      sections.push(`## Time Coverage\n\n${timeParts.join(" | ")}`);
    }
  }

  const geography = pickProperty(processInformation, ["geography"]);
  if (geography) {
    const locationInfo = pickProperty(geography, [
      "locationOfOperationSupplyOrProduction",
      "location_of_operation_supply_or_production",
    ]);
    if (locationInfo) {
      const geoText: string[] = [];
      const location = toDisplayText(
        pickProperty(locationInfo, ["location", "@location"]),
        lang,
      );
      if (location) {
        geoText.push(`**Location:** ${location}`);
      }
      const desc = getLangText(
        pickProperty(locationInfo, [
          "descriptionOfRestrictions",
          "description_of_restrictions",
        ]),
        lang,
      );
      if (desc) {
        geoText.push(`\n${desc}`);
      }
      if (geoText.length) {
        sections.push(`## Geography\n\n${geoText.join("")}`);
      }
    }
  }

  const technology = pickProperty(processInformation, ["technology"]);
  if (technology) {
    let techDesc: string | null = null;
    if (isObject(technology)) {
      const techValue = pickProperty(technology, [
        "technologyDescriptionAndIncludedProcesses",
        "technology_description_and_included_processes",
      ]);
      techDesc = getLangText(techValue ?? technology, lang);
    } else {
      techDesc = getLangText(technology, lang);
    }
    if (techDesc) {
      sections.push(`## Technology\n\n${techDesc}`);
    }
  }

  const modelling = pickProperty(processDataSet, [
    "modellingAndValidation",
    "modelling_and_validation",
  ]);
  if (modelling) {
    const lciMethod = pickProperty(modelling, [
      "LCIMethodAndAllocation",
      "lciMethodAndAllocation",
      "lci_method_and_allocation",
    ]);
    const methodParts: string[] = [];
    const dataSetType = toDisplayText(
      lciMethod
        ? pickProperty(lciMethod, ["typeOfDataSet", "type_of_data_set"])
        : null,
      lang,
    );
    const lciPrinciple = toDisplayText(
      lciMethod
        ? pickProperty(lciMethod, [
          "LCIMethodPrinciple",
          "lciMethodPrinciple",
          "lci_method_principle",
        ])
        : null,
      lang,
    );

    if (dataSetType) methodParts.push(`**Data Set Type:** ${dataSetType}`);
    if (lciPrinciple) methodParts.push(`**LCI Method:** ${lciPrinciple}`);
    if (methodParts.length) {
      sections.push(`## Methodology\n\n${methodParts.join("\n")}`);
    }

    const dataSources = pickProperty(modelling, [
      "dataSourcesTreatmentAndRepresentativeness",
      "data_sources_treatment_and_representativeness",
    ]);
    if (dataSources && isObject(dataSources)) {
      const sampling = getLangText(
        pickProperty(dataSources, ["samplingProcedure", "sampling_procedure"]),
        lang,
      );
      if (sampling) {
        sections.push(`## Data Sources\n\n**Sampling:** ${sampling}`);
      }
    }
  }

  const exchangesObj = pickProperty(processDataSet, ["exchanges"]);
  const exchangeList = ensureArray(
    pickProperty(exchangesObj, ["exchange"]) ?? exchangesObj,
  );
  if (exchangeList.length) {
    const refFlowIdStr = refFlowId ? String(refFlowId) : null;
    const inputsDict: Record<string, number> = {};
    const outputsDict: Record<string, number> = {};

    for (const ex of exchangeList) {
      const exId = pickProperty(ex, [
        "dataSetInternalID",
        "data_set_internal_id",
        "@dataSetInternalID",
        "@data_set_internal_id",
      ]);
      if (
        refFlowIdStr && exId !== undefined && exId !== null &&
        String(exId) === refFlowIdStr
      ) {
        continue;
      }

      const flowName = getFlowName(
        pickProperty(ex, [
          "referenceToFlowDataSet",
          "reference_to_flow_data_set",
        ]),
        lang,
      );
      const amountRaw = pickProperty(ex, [
        "meanAmount",
        "mean_amount",
        "resultingAmount",
        "resulting_amount",
      ]);
      const direction = pickProperty(ex, [
        "exchangeDirection",
        "exchange_direction",
      ]);

      if (flowName !== null && amountRaw !== undefined && amountRaw !== null) {
        const amountSource = typeof amountRaw === "string"
          ? amountRaw.trim()
          : amountRaw;
        if (amountSource === "") continue;
        const amount = Number(amountSource);
        if (Number.isFinite(amount)) {
          if (String(direction).toLowerCase() === "input") {
            inputsDict[flowName] = (inputsDict[flowName] ?? 0) + amount;
          } else if (String(direction).toLowerCase() === "output") {
            outputsDict[flowName] = (outputsDict[flowName] ?? 0) + amount;
          }
        }
      }
    }

    const sortedInputs = Object.entries(inputsDict)
      .filter(([, amt]) => amt >= 0.001)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    if (sortedInputs.length) {
      sections.push(
        `## Main Inputs\n\n${
          sortedInputs
            .map(([name, amt]) => `- ${name}: ${Number(amt).toPrecision(4)}`)
            .join("\n")
        }`,
      );
    }

    const sortedOutputs = Object.entries(outputsDict)
      .filter(([, amt]) => amt >= 0.001)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    if (sortedOutputs.length) {
      sections.push(
        `## Main Outputs\n\n${
          sortedOutputs
            .map(([name, amt]) => `- ${name}: ${Number(amt).toPrecision(4)}`)
            .join("\n")
        }`,
      );
    }
  }

  const administrative = pickProperty(processDataSet, [
    "administrativeInformation",
    "administrative_information",
  ]);
  const publicationOwnership = administrative
    ? pickProperty(administrative, [
      "publicationAndOwnership",
      "publication_and_ownership",
    ])
    : undefined;
  const version = publicationOwnership
    ? toDisplayText(
      pickProperty(publicationOwnership, [
        "common:dataSetVersion",
        "common_data_set_version",
        "dataSetVersion",
        "version",
      ]),
      lang,
    )
    : undefined;
  if (version) {
    sections.push(`**Version:** ${version}`);
  }

  return sections.join("\n\n").trim();
};

Deno.serve(async (req) => {
  const authResult = await authenticateRequest(req, {
    supabase: supabaseClient,
    allowedMethods: [AuthMethod.SERVICE_API_KEY],
    serviceApiKey: req.headers.get("apikey") || undefined,
  });
  console.log("apikey header:", req.headers.get("apikey"));
  console.log("Authentication result:", authResult);

  if (!authResult.isAuthenticated) {
    return authResult.response!;
  }

  try {
    const payload: WebhookPayload = await req.json();
    const { type, record } = payload;

    if (type !== "INSERT" && type !== "UPDATE") {
      return new Response("Ignored operation type", {
        status: 200,
        headers: corsHeaders,
      });
    }

    if (!record) {
      throw new Error("No record data found");
    }

    const { id, version } = record as { id?: string; version?: string };
    if (!id || !version) {
      throw new Error("Record is missing id or version");
    }

    const jsonDataRaw = (record as Record<string, any>).json_ordered;
    if (typeof jsonDataRaw === "string") {
      try {
        (record as Record<string, any>).json_ordered = JSON.parse(jsonDataRaw);
      } catch (error) {
        throw new Error(
          `Failed to parse json_ordered string: ${
            error instanceof Error ? error.message : "unknown"
          }`,
        );
      }
    }
    const jsonData = (record as Record<string, any>).json_ordered;
    if (!jsonData) {
      throw new Error("No json_ordered data found in record");
    }

    const markdown = tidasProcessToMarkdown(jsonData);
    if (!markdown) throw new Error("Empty extracted markdown");

    const { error: updateError } = await supabaseClient
      .from("processes")
      .update({
        extracted_md: markdown,
      })
      .eq("id", id)
      .eq("version", version);

    if (updateError) {
      throw updateError;
    }
    console.log(markdown);
    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error) {
    const errorMessage = error instanceof Error
      ? error.message
      : "Unknown error occurred";
    console.error(errorMessage);
    return new Response(JSON.stringify({ error: errorMessage }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
