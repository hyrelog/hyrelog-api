import { ECSClient, UpdateServiceCommand } from "@aws-sdk/client-ecs";

const ecs = new ECSClient({ region: process.env.AWS_REGION || "ap-southeast-2" });

export const handler = async (event) => {
  console.log("rotation-event", JSON.stringify(event));

  const cluster = process.env.ECS_CLUSTER;
  const services = (process.env.ECS_SERVICES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!cluster || services.length === 0) {
    throw new Error("Missing ECS_CLUSTER or ECS_SERVICES");
  }

  for (const service of services) {
    await ecs.send(
      new UpdateServiceCommand({
        cluster,
        service,
        forceNewDeployment: true
      })
    );
    console.log(`Forced new deployment for ${cluster}/${service}`);
  }

  return { ok: true };
};
