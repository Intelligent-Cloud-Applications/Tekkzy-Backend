const {
  Route53DomainsClient,
  GetOperationDetailCommand
} = require("@aws-sdk/client-route-53-domains");

const {
  Route53Client,
  CreateHostedZoneCommand,
  ListHostedZonesByNameCommand
} = require("@aws-sdk/client-route-53");

const crypto = require("crypto");

const domainClient = new Route53DomainsClient({ region: "us-east-1" });
const route53Client = new Route53Client({ region: "us-east-1" });

const normalizeDomain = (value = "") =>
  value
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "")
    .replace(/\.$/, "");

module.exports.main = async (event) => {

  try {

    const { operationId, domain } = JSON.parse(event.body || {});

    if (!operationId || !domain) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          success: false,
          message: "operationId and domain required"
        })
      };
    }

    const normalizedDomain = normalizeDomain(domain);

    /* ---------- Check Registration Status ---------- */

    const result = await domainClient.send(
      new GetOperationDetailCommand({
        OperationId: operationId
      })
    );

    let hostedZoneId = null;
    let nameServers = [];

    /* ---------- If Domain Registered ---------- */

    if (result.Status === "SUCCESSFUL") {

      /* Check if hosted zone already exists */

      const existingZones = await route53Client.send(
        new ListHostedZonesByNameCommand({
          DNSName: normalizedDomain,
          MaxItems: "1"
        })
      );

      const existingZone = existingZones.HostedZones?.find(
        z => z.Name.replace(/\.$/, "") === normalizedDomain
      );

      let zone;

      if (existingZone) {
        hostedZoneId = existingZone.Id;
        nameServers = existingZone.DelegationSet?.NameServers || [];
      } else {

        zone = await route53Client.send(
          new CreateHostedZoneCommand({
            Name: normalizedDomain,
            CallerReference: crypto.randomUUID()
          })
        );

        hostedZoneId = zone.HostedZone.Id;
        nameServers = zone.DelegationSet.NameServers;
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        status: result.Status,
        domainReady: result.Status === "SUCCESSFUL",
        hostedZoneId,
        nameServers
      })
    };

  } catch (err) {

    console.error("Domain status error:", err);

    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        error: err.message
      })
    };

  }

};