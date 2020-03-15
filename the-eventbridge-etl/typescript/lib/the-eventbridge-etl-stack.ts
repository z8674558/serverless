import * as cdk from '@aws-cdk/core';
import s3 = require('@aws-cdk/aws-s3');
import s3n = require("@aws-cdk/aws-s3-notifications");
import sqs = require('@aws-cdk/aws-sqs');
import { SqsEventSource } from '@aws-cdk/aws-lambda-event-sources';
import lambda = require('@aws-cdk/aws-lambda');
import ec2 = require('@aws-cdk/aws-ec2');
import ecs = require('@aws-cdk/aws-ecs');
import logs = require('@aws-cdk/aws-logs');
import iam = require('@aws-cdk/aws-iam');
import events = require('@aws-cdk/aws-events');
import events_targets = require('@aws-cdk/aws-events-targets');
import dynamodb = require('@aws-cdk/aws-dynamodb');

export class TheEventbridgeEtlStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    /**
     * DynamoDB Table
     * This is where our transformed data ends up
     */
    const table = new dynamodb.Table(this, 'TransformedData', {
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING }
    });

    /**
     * S3 Landing Bucket
     * This is where the user uploads the file to be transformed
     */
    let bucket = new s3.Bucket(this, 'LandingBucket', {
    });

    /**
     * Queue that listens for S3 Bucket events
     */
    const queue = new sqs.Queue(this, 'newObjectInLandingBucketEventQueue', {
      visibilityTimeout: cdk.Duration.seconds(300)
    });

    bucket.addEventNotification(s3.EventType.OBJECT_CREATED, new s3n.SqsDestination(queue));

    /**
     * EventBridge Permissions
     */
    let eventbridgePutPolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      resources: ['*'],
      actions: ['events:PutEvents']
    });

    /**
     * Fargate ECS Task Creation to pull data from S3
     * 
     * Fargate is used here because if you had a seriously large file,
     * you could stream the data to fargate for as long as needed before
     * putting the data onto eventbridge or up the memory/storage to 
     * download the whole file. Lambda has limitations on runtime and 
     * memory/storage
     */
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2, // Default is all AZs in the region
    });

    const logging = new ecs.AwsLogDriver({
      streamPrefix: 'TheEventBridgeETL',
      logRetention: logs.RetentionDays.ONE_WEEK,
    });

    const cluster = new ecs.Cluster(this, 'Ec2Cluster', {
      vpc: vpc
    });

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'ProducerTaskDefinition', {
      memoryLimitMiB: 512,
      cpu: 256
    });

    // We need to give our fargate container permission to put events on our EventBridge
    taskDefinition.addToTaskRolePolicy(eventbridgePutPolicy);
    // Grant fargate container access to the object that was uploaded to s3
    bucket.grantRead(taskDefinition.taskRole);

    let container = taskDefinition.addContainer('AppContainer', {
      image: ecs.ContainerImage.fromAsset('container/s3DataExtractionTask'),
      logging,
      environment: { // clear text, not for sensitive data
        'S3_BUCKET_NAME': bucket.bucketName,
        'S3_OBJECT_KEY': ''
      },
    });

    /**
     * Lambdas
     * 
     * These are used for 3 phases:
     * extract - kicks of ecs fargate task to download data and splinter to eventbridge events
     * transform - takes the two comma separated strings and produces a json object
     * load - insterts the data into dynamodb
     */


    /**
     * Extract
     */
    // defines an AWS Lambda resource to trigger our fargate ecs task
    const sqsSubscribeLambda = new lambda.Function(this, 'SQSSubscribeLambdaHandler', {
      runtime: lambda.Runtime.NODEJS_12_X,
      code: lambda.Code.asset('lambdas/subscribe'), 
      handler: 'newObjectInLandingBucketEventQueue.handler',
      reservedConcurrentExecutions: 2, 
      environment: {
        CLUSTER_NAME: cluster.clusterName,
        TASK_DEFINITION: taskDefinition.taskDefinitionArn,
        SUBNETS: JSON.stringify(Array.from(vpc.privateSubnets, x => x.subnetId)),
        CONTAINER_NAME: container.containerName
      }
    });
    queue.grantConsumeMessages(sqsSubscribeLambda);
    sqsSubscribeLambda.addEventSource(new SqsEventSource(queue, {}));

    const runTaskPolicyStatement = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ecs:RunTask'
      ],
      resources: [
        taskDefinition.taskDefinitionArn,
      ]
    });
    sqsSubscribeLambda.addToRolePolicy(runTaskPolicyStatement);

    const taskExecutionRolePolicyStatement = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'iam:PassRole',
      ],
      resources: [
        taskDefinition.obtainExecutionRole().roleArn,
        taskDefinition.taskRole.roleArn,
      ]
    });
    sqsSubscribeLambda.addToRolePolicy(taskExecutionRolePolicyStatement);

    /**
     * Transform
     */
    // defines a lambda to transform the data that was extracted from s3
    const transformLambda = new lambda.Function(this, 'TransformLambdaHandler', {
      runtime: lambda.Runtime.NODEJS_12_X,
      code: lambda.Code.asset('lambdas/transform'),
      handler: 'transform.handler',
      timeout: cdk.Duration.seconds(3)
    });
    transformLambda.addToRolePolicy(eventbridgePutPolicy);

    // Create EventBridge rule to route failures
    const transformRule = new events.Rule(this, 'transformRule', {
      description: 'Data extracted from S3, Needs transformed',
      eventPattern: {
        source: ['cdkpatterns.the-eventbridge-etl'],
        detailType: ['s3RecordExtraction'],
        detail: {
          status: ["extracted"]
        }
      }
    });

    transformRule.addTarget(new events_targets.LambdaFunction(transformLambda));

    /**
     * Load
     */
    // load the transformed data in dynamodb
    const loadLambda = new lambda.Function(this, 'LoadLambdaHandler', {
      runtime: lambda.Runtime.NODEJS_12_X,
      code: lambda.Code.asset('lambdas/load'),
      handler: 'load.handler',
      timeout: cdk.Duration.seconds(3),
      environment: {
        TABLE_NAME: table.tableName
      }
    });
    loadLambda.addToRolePolicy(eventbridgePutPolicy);
    table.grantReadWriteData(loadLambda);

    // Create EventBridge rule to route failures
    const loadRule = new events.Rule(this, 'loadRule', {
      description: 'Data transformed, Needs loaded into dynamodb',
      eventPattern: {
        source: ['cdkpatterns.the-eventbridge-etl'],
        detailType: ['transform'],
        detail: {
          status: ["transformed"]
        }
      }
    });

    loadRule.addTarget(new events_targets.LambdaFunction(loadLambda));
  }
}
