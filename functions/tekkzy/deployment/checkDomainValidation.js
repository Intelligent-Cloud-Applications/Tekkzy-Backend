const { acm, DescribeCertificateCommand } = require("../../../Utils/awsConfig");
const { response } = require("../../../Utils/Functions");

module.exports.main = async (event) => {

  try {

    const { certificateArn } = event.queryStringParameters;

    if (!certificateArn) {
      return response(400, {
        success: false,
        message: "certificateArn is required"
      });
    }

    const res = await acm.send(
      new DescribeCertificateCommand({
        CertificateArn: certificateArn
      })
    );

    const status = res.Certificate.Status;

    let action = "WAIT";

    if (status === "ISSUED") {
      action = "CREATE_CLOUDFRONT";
    }

    if (["FAILED", "EXPIRED", "REVOKED"].includes(status)) {
      action = "STOP";
    }

    return response(200, {
      success: true,
      status,
      action
    });

  } catch (err) {

    console.error("Certificate check error:", err);

    return response(500, {
      success: false,
      error: err.message
    });

  }

};