import boto3
import time
import os
import csv

def main():
    # https://stackoverflow.com/questions/4906977/how-to-access-environment-variable-values

    data_s3_bucket_name = os.environ.get('S3_BUCKET_NAME')
    data_s3_object_key  = os.environ.get('S3_OBJECT_KEY')

    if (None == data_s3_bucket_name
     or None == data_s3_object_key):
        print('ERROR: unable to retrieve environment variables (s3 bucket or object ket, stream name')
        exit(1)

    local_file = '/tmp/data.tsv'

    s3_resource = boto3.resource('s3')
    s3_resource.Object(data_s3_bucket_name, data_s3_object_key).download_file(local_file)

    print('SUCCESS: data file downloaded: ' + local_file)
    exit(0)

if __name__ == '__main__':
    main()
