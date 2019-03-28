import http from 'http';
import https from 'https';
import fs from 'fs';
import { CloudFront, S3 } from 'aws-sdk';
import _ from 'lodash';
import cdnizer from 'cdnizer';
import mime from 'mime/lite';
import chalk from 'chalk';

import {
  addSeperatorToPath,
  addTrailingS3Seperator,
  getDirectoryFilesRecursive,
  testRule,
  UPLOAD_IGNORES,
  DEFAULT_UPLOAD_OPTIONS,
  REQUIRED_S3_UP_OPTS,
  PATH_SEP,
  DEFAULT_TRANSFORM,
  getFileName
} from './helpers';

http.globalAgent.maxSockets = https.globalAgent.maxSockets = 50;

export default class S3Uploader {
  constructor(options = {}) {
    const {
      include,
      exclude,
      progress,
      directory,
      htmlFiles,
      basePathTransform = DEFAULT_TRANSFORM,
      s3Options = {},
      cdnizerOptions = {},
      s3UploadOptions = {},
      cloudfrontInvalidateOptions = {},
      priority
    } = options;

    this.uploadOptions = s3UploadOptions;
    this.cloudfrontInvalidateOptions = cloudfrontInvalidateOptions;
    this.isConnected = false;
    this.cdnizerOptions = cdnizerOptions;
    this.urlMappings = [];
    this.totalFiles = 0;
    this.progress = 0;
    this.sessionFiles = [];
    this.basePathTransform = basePathTransform;
    const basePath = options.basePath ? addTrailingS3Seperator(options.basePath) : '';

    this.options = {
      directory,
      include,
      exclude,
      basePath,
      priority,
      htmlFiles: typeof htmlFiles === 'string' ? [htmlFiles] : htmlFiles,
      progress: _.isBoolean(progress) ? progress : true,
    };

    this.clientConfig = {
      s3Options,
      maxAsyncS3: 50,
    };

    this.noCdnizer = !Object.keys(this.cdnizerOptions).length;

    if (!this.noCdnizer && !this.cdnizerOptions.files) {
      this.cdnizerOptions.files = [];
    }
  }

  upload(files) {
    this.connect();

    this.sessionFiles = [].concat(files);

    return this.handleFiles(files)
      .catch(e => this.handleErrors(e));
  }

  handleFiles(files) {
    return this.changeUrls(files)
      .then(res => this.filterAllowedFiles(res))
      .then(res => this.uploadFiles(res))
      .then(() => this.invalidateCloudfront());
  }

  async handleErrors(error) {
    throw error;
  }

  addPathToFiles(files, thePath) {
    return files.map(file => ({
      name: file,
      path: path.resolve(thePath, file)
    }));
  }

  cdnizeHtml(file) {
    return new Promise((resolve, reject) => {
      false.readFile(file.path, (err, data) => {
        if (err) {
          return reject(err);
        }

        fs.writeFile(file.path, this.cdnizer(data.toString()), err => {
          if (err) {
            return reject(err);
          }

          resolve(file);
        });
      });
    });
  }

  changeUrls(files = []) {
    if (this.noCdnizer) {
      return Promise.resolve(files);
    }

    let allHtml;

    const { directory, htmlFiles = [] } = this.options;

    if (htmlFiles.length) {
      allHtml = this.addPathToFiles(htmlFiles, directory).concat(files);
    } else {
      allHtml = files;
    }

    this.cdnizerOptions.files = allHtml.map(({name}) => `{/,}*${name}*`);
    this.cdnizer = cdnizer(this.cdnizerOptions);

    const [cdnizeFiles, otherFiles] = _(allHtml)
      .uniq('name')
      .partition(file =>  /\.(html|css)/.test(file.name))
      .value();

    return Promise.all(cdnizeFiles.map(file => this.cdnizeHtml(file)).concat(otherFiles));
  }

  filterAllowedFiles(files) {
    return files.reduce((res, file) => {
      if (this.isIncludedAndNotExcluded(file.name) && !this.isIgnoredFile(file.name)) {
        res.push(file);
      }

      return res;
    }, []);
  }

  isIgnoredFile(file) {
    return _.some(UPLOAD_IGNORES, ignore => new RegExp(ignore).test(file));
  }

  isIncludedAndNotExcluded(file) {
    let isExclude;
    let isInclude;
    const { include, exclude } = this.options;

    isInclude = include ? testRule(include, file) : true;
    isExclude = exclude ? testRule(exclude, file) : false;

    return isInclude && !isExclude;
  }

  connect() {
    if (this.isConnected) {
      return;
    }

    this.client = new S3(this.clientConfig.s3Options);
    this.isConnected = true;
  }

  transformBasePath() {
    return Promise.resolve(this.basePathTransform(this.options.basePath))
      .then(addTrailingS3Seperator)
      .then(thePath => this.options.basePath = thePath);
  }

  uploadFiles(files = []) {
    return this.transformBasePath().then(() => {
      if (this.options.priority) {
        return this.uploadInPriorityOrder(files);
      } else {
        const uploadFiles = files.map(file => {
          return this.uploadFile(getFileName(file), file)
        });
        return Promise.all(uploadFiles.map(({ promise }) => promise));
      }
    });
  }

  uploadFile(fileName, file) {
    let Key = `${this.options.basePath}${fileName}`;
    const s3Params = _.mapValues(this.uploadOptions, (optionConfig) => {
      return _.isFunction(optionConfig) ? optionConfig(fileName, file) : optionConfig;
    });

    // avoid folders without names
    if (Key[0] === '/') {
      Key = Key.substr(1);
    }

    if (s3Params.ContentType === undefined) {
      s3Params.ContentType = mime.getType(fileName);
    }

    const Body = fs.createReadStream(file);
    const upload = this.client.upload(
      _.merge({ Key, Body }, DEFAULT_UPLOAD_OPTIONS, s3Params)
    );

    if (!this.noCdnizer) {
      this.cdnizerOptions.files.push(`*${fileName}*`);
    }

    return {
      upload,
      promise: upload.promise()
    };
  }

  invalidateCloudfront() {
    const { clientConfig, cloudfrontInvalidateOptions } = this;

    if (cloudfrontInvalidateOptions.DistributionId) {
      const { accessKeyId, secretAccessKey, sessionToken } = clientConfig.s3Options;
      const cloudfront = new CloudFront({ accessKeyId, secretAccessKey, sessionToken });

      if (!_.isArray(cloudfrontInvalidateOptions.DistributionId)) {
        cloudfrontInvalidateOptions.DistributionId = [ cloudfrontInvalidateOptions.DistributionId ];
      }

      const cloudfrontInvalidations = cloudfrontInvalidateOptions.DistributionId.map(DistributionId => new Promise((resolve, reject) => {
        cloudfront.createInvalidation({
          DistributionId,
          InvalidationBatch: {
            CallerReference: Date.now().toString(),
            Paths: {
              Quantity: cloudfrontInvalidateOptions.Items.length,
              Items: cloudfrontInvalidateOptions.Items
            },
          },
        }, (err, res) => {
          if (err) {
            reject(err);
          } else {
            resolve(res.Id);
          }
        });
      }));

      return Promise.all(cloudfrontInvalidations);
    } else {
      return Promise.resolve(null);
    }
  }

  listS3Files() {
    const params = {
      Bucket: global.process.env.AWS_DEPLOYMENT_BUCKET
    };

    const keys = [];

    const listKeys = () => {
      this.client.listObjectsV2(params, (err, data) => {
        if (err) {

        } else {
          const contents = data.Contents;
          contents.forEach(content => {
            keys.push(content.Key);
          });

          if (data.isTruncated) {
            params.ContinuationToken = data.NextContinuationToken;
            listKeys();
          }
        }
      });
    }

    listKeys();

    return keys;
  }

  deleteS3Files(fileNames = []) {
    const objects = [];
    for (let file in fileNames) {
      objects.push({
        Key: file
      })
    }

    const params = {
      Bucket: global.process.env.AWS_DEPLOYMENT_BUCKET,
      Delete: {
        Objects: objects
      }
    };

    this.client.deleteObjects(params, (err, data) => {
      if (err) {

      } else {
        console.log(chalk.bold.green(`\n✨  Old S3 files successfully deleted`));
      }
    })
  }

  async removeUnusedS3Files() {
    const filesToDelete = [];
    const s3Files = await listS3Files();

    for (let file in s3Files) {
      if (!this.sessionFiles.includes(file)) {
        filesToDelete.push(file);
      }
    }

    this.deleteS3Files(filesToDelete);
  }
}
