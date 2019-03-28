import chalk from 'chalk';
import * as AWS from 'aws-sdk';

import S3Uploader from './uploader';

module.exports = bundler => {
  bundler.on('bundled', async bundle => {
    if (global.process.env.NODE_DEPLOY === 'true') {
      if (global.process.env.NODE_ENV === 'production' || global.process.env.NODE_ENV === 'staging') {

        const start = new Date().getTime();
        console.log(chalk.bold('\n🗜️  Deploying...\n'));

        // globalprocess.env.AWS_SDK_LOAD_CONFIG = true;
        // process.env.AWS_REGION = "us-east-1";

        const awsCredentials = new AWS.SharedIniFileCredentials({ profile: global.process.env.AWS_CREDENTIALS_PROFILE || 'default' });

        // AWS.config.credentials = awsCredentials;

        // main asset and package dir, depending on version of parcel-bundler
        let mainAsset =
          bundler.mainAsset ||                                                // parcel < 1.8
          bundler.mainBundle.entryAsset ||                                    // parcel >= 1.8 single entry point
          bundler.mainBundle.childBundles.values().next().value.entryAsset;   // parcel >= 1.8 multiple entry points
        let pkg;
        if (typeof mainAsset.getPackage === 'function') {                       // parcel > 1.8
          pkg = (await mainAsset.getPackage());
        } else {                                   // parcel <= 1.8
          pkg = mainAsset.package;
        }

        const uploadOptions = pkg.uploadS3 || {
          s3Options: {
            accessKeyId: awsCredentials.accessKeyId,
            secretAccessKey: awsCredentials.secretAccessKey,
          },
          s3UploadOptions: {
            Bucket: global.process.env.AWS_DEPLOYMENT_BUCKET,
            ACL: 'private',
          },
          cdnizerOptions: {
            defaultCDNBase: global.process.env.AWS_DEPLOYMENT_CDN_BASE,
          },
          cloudfrontInvalidateOptions: {
            DistributionId: global.process.env.AWS_DEPLOYMENT_CLOUDFRONT_DISTRIBUTION_ID,
            Items: ['/*'],
          },
        };

        const uploader = new S3Uploader(uploadOptions);

        function* filesToUpload(bundle) {
          if (bundle.name) {
            yield bundle.name;
          }
          for (let child of bundle.childBundles) {
            yield* filesToUpload(child);
          }
        }

        const files = [...filesToUpload(bundle)];

        await uploader.upload(files);

        const s3Files = await uploader.listS3Files();

        console.log(s3Files);

        const end = new Date().getTime();

        console.log(chalk.bold.green(`\n✨  Deployed in ${((end - start) / 1000).toFixed(2)}s.\n`));

      } else {
        console.error(chalk.bold.red(`❌  Can only deploy in "production" and "staging" environments`));
      }
    } else {
      console.info(chalk.bold.yellow('❌  Not deploying.'));
    }
  })
}