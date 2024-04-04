import { request } from "../../shared/cognito.js";

export const handler = async (event) => {
  try {
    const params = JSON.parse(event.body);

    // TODO: Temporary solution, should be replaced with a API call to /api-tools/user-pool/{device}/{username}
    params.ClientId = process.env.COGNITO_CLIENT_ID;

    const response = await request("InitiateAuth", params);

    return {
      statusCode: 200,
      body: JSON.stringify(response.data),
    };
  } catch (error) {
    console.error(error);

    return {
      statusCode: error.status || 500,
      body: JSON.stringify(error),
    };
  }
};
