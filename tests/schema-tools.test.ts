import { describe, expect, it } from "vitest";
import { buildAttributeBody } from "../src/tools/schema-tools.js";

describe("buildAttributeBody", () => {
  it("builds String attribute body", () => {
    const body = buildAttributeBody({
      logical_name: "contoso_name",
      type: "String",
      display_name: "Name",
      max_length: 100,
    });
    expect(body["@odata.type"]).toBe(
      "Microsoft.Dynamics.CRM.StringAttributeMetadata",
    );
    expect(body.LogicalName).toBe("contoso_name");
    expect(body.MaxLength).toBe(100);
    expect(body.RequiredLevel).toEqual({ Value: "None" });
  });

  it("builds Integer attribute with min/max", () => {
    const body = buildAttributeBody({
      logical_name: "contoso_count",
      type: "Integer",
      display_name: "Count",
      min_value: 0,
      max_value: 1000,
    });
    expect(body["@odata.type"]).toBe(
      "Microsoft.Dynamics.CRM.IntegerAttributeMetadata",
    );
    expect(body.MinValue).toBe(0);
    expect(body.MaxValue).toBe(1000);
  });

  it("builds Decimal attribute with precision", () => {
    const body = buildAttributeBody({
      logical_name: "contoso_amount",
      type: "Decimal",
      display_name: "Amount",
      precision: 4,
    });
    expect(body["@odata.type"]).toBe(
      "Microsoft.Dynamics.CRM.DecimalAttributeMetadata",
    );
    expect(body.Precision).toBe(4);
  });

  it("sets required level", () => {
    const body = buildAttributeBody({
      logical_name: "contoso_required",
      type: "String",
      display_name: "Required Field",
      required: "ApplicationRequired",
    });
    expect(body.RequiredLevel).toEqual({ Value: "ApplicationRequired" });
  });

  it("includes description when provided", () => {
    const body = buildAttributeBody({
      logical_name: "contoso_desc",
      type: "String",
      display_name: "With Desc",
      description: "A description",
    });
    expect(body.Description).toBeDefined();
    const labels = (body.Description as Record<string, unknown>)
      .LocalizedLabels as Array<{ Label: string }>;
    expect(labels[0].Label).toBe("A description");
  });

  it("omits optional fields when not provided", () => {
    const body = buildAttributeBody({
      logical_name: "contoso_simple",
      type: "String",
      display_name: "Simple",
    });
    expect(body.MaxLength).toBeUndefined();
    expect(body.MinValue).toBeUndefined();
    expect(body.MaxValue).toBeUndefined();
    expect(body.Precision).toBeUndefined();
    expect(body.Description).toBeUndefined();
  });

  it("generates SchemaName from logical_name", () => {
    const body = buildAttributeBody({
      logical_name: "contoso_myfield",
      type: "String",
      display_name: "My Field",
    });
    expect(body.SchemaName).toBe("Contoso_myfield");
  });

  it("builds Boolean attribute with default Yes/No options", () => {
    const body = buildAttributeBody({
      logical_name: "contoso_active",
      type: "Boolean",
      display_name: "Active",
    });
    expect(body["@odata.type"]).toBe(
      "Microsoft.Dynamics.CRM.BooleanAttributeMetadata",
    );
    const optionSet = body.OptionSet as Record<string, any>;
    expect(optionSet.TrueOption.Value).toBe(1);
    expect(optionSet.FalseOption.Value).toBe(0);
    expect(optionSet.TrueOption.Label.LocalizedLabels[0].Label).toBe("Yes");
    expect(optionSet.FalseOption.Label.LocalizedLabels[0].Label).toBe("No");
  });

  it("builds Boolean attribute with custom options", () => {
    const body = buildAttributeBody({
      logical_name: "contoso_verified",
      type: "Boolean",
      display_name: "Verified",
      options: [
        { label: "Unverified", value: 0 },
        { label: "Verified", value: 1 },
      ],
    });
    const optionSet = body.OptionSet as Record<string, any>;
    expect(optionSet.TrueOption.Label.LocalizedLabels[0].Label).toBe("Verified");
    expect(optionSet.FalseOption.Label.LocalizedLabels[0].Label).toBe("Unverified");
  });

  it("builds Picklist attribute with options", () => {
    const body = buildAttributeBody({
      logical_name: "contoso_status",
      type: "Picklist",
      display_name: "Status",
      options: [
        { label: "Active", value: 100000 },
        { label: "Inactive", value: 100001 },
        { label: "Pending", value: 100002 },
      ],
    });
    expect(body["@odata.type"]).toBe(
      "Microsoft.Dynamics.CRM.PicklistAttributeMetadata",
    );
    const optionSet = body.OptionSet as Record<string, any>;
    expect(optionSet.Options).toHaveLength(3);
    expect(optionSet.Options[0].Value).toBe(100000);
    expect(optionSet.Options[0].Label.LocalizedLabels[0].Label).toBe("Active");
  });

  it("builds Lookup attribute with targets", () => {
    const body = buildAttributeBody({
      logical_name: "contoso_accountid",
      type: "Lookup",
      display_name: "Account",
      targets: ["account"],
    });
    expect(body["@odata.type"]).toBe(
      "Microsoft.Dynamics.CRM.LookupAttributeMetadata",
    );
    expect(body.Targets).toEqual(["account"]);
  });
});
