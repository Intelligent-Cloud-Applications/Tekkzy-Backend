const response = (statusCode, body) => {
  return {
    statusCode,
    body: JSON.stringify(body),
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Credentials": true,
    },
  };
};

const parseBase64Image = (base64Input) => {
  if (!base64Input || typeof base64Input !== "string") {
    return null;
  }

  let base64 = base64Input.trim();
  let contentType = "image/jpeg";
  let extension = "jpg";

  const dataUrlMatch = base64.match(/^data:(image\/[\w.+-]+);base64,(.+)$/is);
  if (dataUrlMatch) {
    contentType = dataUrlMatch[1];
    base64 = dataUrlMatch[2];
  }

  base64 = base64.replace(/\s/g, "");
  const buffer = Buffer.from(base64, "base64");
  if (!buffer.length) {
    return null;
  }

  if (!dataUrlMatch) {
    if (buffer[0] === 0x89 && buffer[1] === 0x50) {
      contentType = "image/png";
      extension = "png";
    } else if (buffer[0] === 0xff && buffer[1] === 0xd8) {
      contentType = "image/jpeg";
      extension = "jpg";
    } else if (buffer[0] === 0x47 && buffer[1] === 0x49) {
      contentType = "image/gif";
      extension = "gif";
    } else if (buffer[0] === 0x52 && buffer[1] === 0x49) {
      contentType = "image/webp";
      extension = "webp";
    }
  } else if (contentType === "image/png") {
    extension = "png";
  } else if (contentType === "image/gif") {
    extension = "gif";
  } else if (contentType === "image/webp") {
    extension = "webp";
  }

  return { buffer, contentType, extension };
};

module.exports = {
  response,
  parseBase64Image,
};
